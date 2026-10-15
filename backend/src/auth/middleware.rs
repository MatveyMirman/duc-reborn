use crate::{
    api::AppState,
    db::schema::get_session,
};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct AuthUser {
    pub user_id: i64,
    pub username: String,
    pub role: String,
}

/// Extract the `session=<id>` cookie value from a Cookie header, if present.
fn extract_session_id(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get("cookie")?;
    let cookie_str = cookie_header.to_str().ok()?;
    for cookie in cookie_str.split(';') {
        let trimmed = cookie.trim();
        if let Some(rest) = trimmed.strip_prefix("session=") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

pub async fn require_auth(
    State(state): State<Arc<Mutex<AppState>>>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if std::env::var("DUC_REQUIRE_AUTH")
        .map(|v| v == "false" || v == "0")
        .unwrap_or(false)
    {
        return Ok(next.run(request).await);
    }

    let session_id = match extract_session_id(&headers) {
        Some(id) => id,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match get_session(&conn, &session_id) {
        Ok(Some(session)) => {
            drop(conn);
            request.extensions_mut().insert(AuthUser {
                user_id: session.user_id,
                username: session.username,
                role: session.role,
            });
            Ok(next.run(request).await)
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
