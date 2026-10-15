# DUC Reborn

**D**ude **U**nderstand **C**harts - A modern disk usage analyzer with WizTree-style treemap visualization.

## Features

- **Fast Scanner**: Parallel directory traversal using Rust + rayon
- **Visualizations**: Treemap (WizTree-style) and Pie chart views
- **Authentication**: Secure session-based login with Argon2 password hashing
- **Scan History**: SQLite database stores past scans
- **Docker Ready**: Single container deployment with bind mount support

## Quick Start

```bash
# Build and run with Docker
cd docker
docker-compose up --build

# Access the UI
open http://localhost:8080
```

## First Login

1. On first run, an admin user is automatically created from environment variables:
   - `DUC_ADMIN_USERNAME` (default: `admin`)
   - `DUC_ADMIN_PASSWORD` (**required** — the app exits without it on first run)
2. Login with those credentials at the UI. Sessions are UUID-based and stored in SQLite.
3. To disable authentication entirely (e.g. for a trusted local network), set `DUC_REQUIRE_AUTH=false`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DUC_ADMIN_USERNAME` | `admin` | Admin username created on first run |
| `DUC_ADMIN_PASSWORD` | _(none)_ | Admin password (required on first run) |
| `DUC_REQUIRE_AUTH` | `true` | Set to `false` to disable auth on protected routes |
| `DUC_SESSION_EXPIRY_HOURS` | `24` | Session lifetime in hours |
| `DUC_DB_PATH` | `./duc.db` | SQLite database path |
| `DUC_CORS_ORIGINS` | `*` | Comma-separated origins. Use specific origins with auth (cookies); `*` only works when `DUC_REQUIRE_AUTH=false` |

## Usage

### Starting a Scan

1. Enter a path in the scan input (e.g., `/scan/root`)
2. Click "Start Scan"
3. View results in List, Treemap, or Pie chart mode

### Docker Deployment

```yaml
# docker-compose.yml
services:
  duc-reborn:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data          # Database storage
      - /path/to/scan:/scan/root:ro  # Bind mount filesystem to scan
    environment:
      - RUST_LOG=info
      - DUC_ADMIN_USERNAME=admin
      - DUC_ADMIN_PASSWORD=changeme
      - DUC_REQUIRE_AUTH=true
      - DUC_CORS_ORIGINS=http://localhost:8080
    restart: unless-stopped
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/status` | Check auth status |
| POST | `/api/scan` | Start a scan |
| GET | `/api/scan/:id` | Get scan details |
| GET | `/api/scan/:id/tree` | Get scan tree data |
| GET | `/api/history` | List scan history |

### Scan Request Example

```bash
curl -X POST http://localhost:8080/api/scan \
  -H "Content-Type: application/json" \
  -d '{"path": "/scan/root"}'
```

## Tech Stack

- **Backend**: Rust + Axum + SQLite
- **Scanner**: walkdir + rayon (parallel traversal)
- **Frontend**: React + TypeScript + Vite
- **Visualizations**: @nivo (treemap, pie)
- **Auth**: Argon2 password hashing

## Development

### Backend Development (API-only mode)

```bash
cd backend

# Copy environment file
cp ../.env.example .env

# Run the backend (auto-reload on changes)
cargo watch -x run

# Or without cargo-watch
cargo run
```

The backend runs in **API-only mode** when `dist/` folder is not present.

### Frontend Development

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server will start on http://localhost:5173 with hot-reload.

### Full Stack Development

```bash
# Terminal 1: Backend
cd backend
cargo run

# Terminal 2: Frontend  
cd frontend
npm run dev
```

### Build Frontend for Production

```bash
cd frontend
npm run build
```

This creates the `dist/` folder which the backend will serve when present.

## License

MIT