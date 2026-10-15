use crate::{
    api::models::{ApiResponse, AuthStatus, LoginRequest, LoginResponse, UserInfo},
    auth::{generate_session_id, hash_password, verify_password},
    db::schema::{create_session, delete_session, get_session, get_user_by_username, user_exists, create_user},
};
use axum::{
    extract::State,
    http::{header::SET_COOKIE, HeaderMap, HeaderValue},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthConfig {
    pub credentials_required: bool,
}

pub fn router() -> Router<Arc<Mutex<AppState>>> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/status", get(status))
        .route("/auth/register", post(register))
        .route("/auth/config", get(config))
}

async fn register(
    State(state): State<Arc<Mutex<AppState>>>,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    if user_exists(&conn).unwrap_or(true) {
        return Json(ApiResponse::<LoginResponse>::error("Admin already exists"));
    }

    match hash_password(&payload.password) {
        Ok(hash) => match create_user(&conn, &payload.username, &hash, "admin") {
            Ok(_) => {
                info!("Admin user created: {}", payload.username);
                Json(ApiResponse::success(LoginResponse {
                    success: true,
                    message: "Admin user created successfully".to_string(),
                    user: Some(UserInfo {
                        username: payload.username,
                        role: "admin".to_string(),
                    }),
                }))
            }
            Err(e) => Json(ApiResponse::<LoginResponse>::error(format!(
                "Failed to create user: {e}"
            ))),
        },
        Err(e) => Json(ApiResponse::<LoginResponse>::error(e)),
    }
}

async fn login(
    State(state): State<Arc<Mutex<AppState>>>,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    let user = match get_user_by_username(&conn, &payload.username) {
        Ok(u) => u,
        Err(_) => {
            return (
                HeaderMap::new(),
                Json(ApiResponse::<LoginResponse>::error("Database error"))
            )
        }
    };

    let user = match user {
        Some(u) => u,
        None => {
            return (
                HeaderMap::new(),
                Json(ApiResponse::<LoginResponse>::error("Invalid username or password"))
            )
        }
    };

    if !verify_password(&payload.password, &user.password_hash) {
        return (
            HeaderMap::new(),
            Json(ApiResponse::<LoginResponse>::error("Invalid username or password"))
        );
    }

    let session_id = generate_session_id();
    let expiry_hours = std::env::var("DUC_SESSION_EXPIRY_HOURS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(24);
    let expires_at = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::hours(expiry_hours))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default();

    if let Err(e) = create_session(&conn, &session_id, user.id, &expires_at) {
        return (
            HeaderMap::new(),
            Json(ApiResponse::<LoginResponse>::error(format!(
                "Failed to create session: {e}"
            )))
        );
    }

    info!("User logged in: {}", payload.username);

    let mut headers = HeaderMap::new();
    let cookie_value = format!(
        "session={}; HttpOnly; Path=/; Max-Age={}; SameSite=Strict",
        session_id,
        expiry_hours * 60 * 60
    );
    headers.insert(SET_COOKIE, HeaderValue::from_str(&cookie_value).unwrap());

    (
        headers,
        Json(ApiResponse::success(LoginResponse {
            success: true,
            message: "Login successful".to_string(),
            user: Some(UserInfo {
                username: user.username,
                role: user.role,
            }),
        }))
    )
}

async fn logout(
    State(state): State<Arc<Mutex<AppState>>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if let Some(cookie_header) = headers.get("cookie") {
        if let Ok(cookie_str) = cookie_header.to_str() {
            for cookie in cookie_str.split(';') {
                if cookie.trim().starts_with("session=") {
                    let session_id = cookie.trim().strip_prefix("session=").unwrap_or("");
                    if !session_id.is_empty() {
                        let state = state.lock().await;
                        let conn = state.db.lock().await;
                        let _ = delete_session(&conn, session_id);
                    }
                }
            }
        }
    }

    (
        [(SET_COOKIE, "session=; HttpOnly; Path=/; Max-Age=0")],
        Json(ApiResponse::<()>::success(()))
    )
}

async fn status(
    State(state): State<Arc<Mutex<AppState>>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let mut auth_status = AuthStatus {
        authenticated: false,
        user: None,
    };

    if let Some(cookie_header) = headers.get("cookie") {
        if let Ok(cookie_str) = cookie_header.to_str() {
            for cookie in cookie_str.split(';') {
                if cookie.trim().starts_with("session=") {
                    let session_id = cookie.trim().strip_prefix("session=").unwrap_or("");
                    if !session_id.is_empty() {
                        let state = state.lock().await;
                        let conn = state.db.lock().await;

                        if let Ok(Some(session)) = get_session(&conn, session_id) {
                            auth_status = AuthStatus {
                                authenticated: true,
                                user: Some(UserInfo {
                                    username: session.username,
                                    role: session.role,
                                }),
                            };
                        }
                    }
                }
            }
        }
    }

    Json(ApiResponse::success(auth_status))
}

async fn config() -> impl IntoResponse {
    let credentials_required = std::env::var("DUC_REQUIRE_AUTH")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);

    Json(ApiResponse::success(AuthConfig { credentials_required }))
}
