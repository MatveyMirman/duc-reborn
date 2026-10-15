use axum::{
    http,
    http::HeaderValue,
    routing::{get, post},
    Router,
};
use dotenv::dotenv;
use duc_reborn::{
    api::{
        auth::router as auth_router,
        handlers::{
            easter_egg, get_scan, get_scan_tree, get_scan_node, list_history, start_scan,
            delete_scan_handler, get_scan_status, list_running_scans, list_disks_handler,
        },
        create_app_state,
    },
    auth::{hash_password, middleware::require_auth},
    db::schema::{init_db, user_exists, create_user},
};
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

async fn api_not_found() -> http::Response<axum::body::Body> {
    let body = serde_json::json!({
        "success": false,
        "error": "These aren't the bytes you're looking for"
    })
    .to_string();
    http::Response::builder()
        .status(http::StatusCode::NOT_FOUND)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .unwrap()
}

fn parse_cors_config() -> (AllowOrigin, bool) {
    match std::env::var("DUC_CORS_ORIGINS").as_deref() {
        Ok("*") => (AllowOrigin::any(), false),
        Ok(s) if !s.is_empty() => (
            s.split(',')
                .filter_map(|o| HeaderValue::from_str(o.trim()).ok())
                .collect::<Vec<_>>()
                .into(),
            true,
        ),
        _ => (AllowOrigin::any(), false),
    }
}

#[tokio::main]
async fn main() {
    dotenv().ok();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let db_path = std::env::var("DUC_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./duc.db"));

    let tree_dir = db_path.parent()
        .map(|p| p.join("trees"))
        .unwrap_or_else(|| PathBuf::from("./trees"));

    if let Err(e) = std::fs::create_dir_all(&tree_dir) {
        eprintln!("Warning: Failed to create tree directory: {e}");
    }

    let db = init_db(&db_path).expect("Failed to initialize database");

    if !user_exists(&db).expect("Failed to check user existence") {
        let admin_username = std::env::var("DUC_ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
        let admin_password = std::env::var("DUC_ADMIN_PASSWORD")
            .unwrap_or_else(|_| {
                eprintln!("ERROR: DUC_ADMIN_PASSWORD environment variable is required for first run.");
                eprintln!("Set it in your environment or .env file, e.g.: DUC_ADMIN_PASSWORD=yourpassword");
                std::process::exit(1);
            });
        let password_hash = hash_password(&admin_password).expect("Failed to hash admin password");
        create_user(&db, &admin_username, &password_hash, "admin").expect("Failed to create admin user");
        info!("Created admin user: {}", admin_username);
    }

    let state = create_app_state(db, db_path.clone(), tree_dir);

    let (cors_origins, allow_credentials) = parse_cors_config();
    let cors = CorsLayer::new()
        .allow_origin(cors_origins)
        .allow_methods([http::Method::GET, http::Method::POST, http::Method::PUT, http::Method::DELETE])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::ACCEPT,
            http::header::ORIGIN,
            http::header::COOKIE,
            http::header::SET_COOKIE,
        ])
        .expose_headers([http::header::SET_COOKIE])
        .allow_credentials(allow_credentials);

    let public_router = Router::new().route("/easteregg", get(easter_egg));

    let protected_router = Router::new()
        .route("/scan", post(start_scan))
        .route("/scan/:id", get(get_scan).delete(delete_scan_handler))
        .route("/scan/:id/tree", get(get_scan_tree))
        .route("/scan/:id/node", get(get_scan_node))
        .route("/scan/:id/status", get(get_scan_status))
        .route("/scan/running", get(list_running_scans))
        .route("/disks", get(list_disks_handler))
        .route("/history", get(list_history))
        .layer(axum::middleware::from_fn_with_state(state.clone(), require_auth));

    // Check if dist folder exists for serving frontend
    let index_html = std::sync::Arc::new(
        std::fs::read_to_string("dist/index.html")
            .unwrap_or_else(|_| "<!DOCTYPE html><html><body>Frontend not built. Run <code>npm run build</code> in <code>frontend/</code>.</body></html>".to_string()),
    );

    let app = if std::path::Path::new("dist").exists() {
        Router::new()
            .nest("/api", auth_router().merge(public_router).merge(protected_router))
            .fallback_service(ServeDir::new("dist").fallback(tower::service_fn(
                move |req: http::Request<axum::body::Body>| {
                    let html = (*index_html).clone();
                    async move {
                        if req.uri().path().starts_with("/api") {
                            return Ok::<_, std::convert::Infallible>(api_not_found().await);
                        }
                        Ok(
                            http::Response::builder()
                                .status(http::StatusCode::OK)
                                .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
                                .body(axum::body::Body::from(html))
                                .unwrap(),
                        )
                    }
                },
            )))
            .layer(cors)
            .with_state(state)
    } else {
        info!("dist/ folder not found - running in API-only mode");
        Router::new()
            .nest("/api", auth_router().merge(public_router).merge(protected_router))
            .fallback(api_not_found)
            .layer(cors)
            .with_state(state)
    };

    let port: u16 = std::env::var("DUC_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Starting server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
