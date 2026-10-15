# DUC Reborn - Project Plan

## Project Overview
- **Name:** DUC Reborn ("Dude Where Are My Bytes")
- **Purpose:** Modern disk usage analyzer with WizTree-style treemap + pie chart visualizations
- **Deployment:** Docker container (bind mount RO)
- **Core Features:** Local/remote filesystem scanning, interactive visualizations, scan history

## Architecture

```
┌─────────────────────────────────────────┐
│           Docker Container               │
│  ┌─────────────────────────────────┐    │
│  │     Rust Binary (single)        │    │
│  │  ┌───────────┐ ┌────────────┐  │    │
│  │  │  Scanner  │ │  API (Axum)│  │    │
│  │  │ (walkdir  │ │  + static  │  │    │
│  │  │ + rayon)  │ │    files   │  │    │
│  │  └───────────┘ └────────────┘  │    │
│  │           │                    │    │
│  │     ┌─────▼─────┐              │    │
│  │     │  SQLite   │              │    │
│  │     └───────────┘              │    │
│  └─────────────────────────────────┘    │
│            │                            │
│      React Frontend                     │
│  (Pie Chart + Treemap)                  │
└─────────────────────────────────────────┘
         │                    │
    ┌────▼────┐         ┌─────▼─────┐
    │  Local  │         │   SSH     │
    │   FS    │         │  Remote   │
    │ (bind   │         │           │
    │ mount)  │         │           │
    └─────────┘         └───────────┘
```

## Tech Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Scanner | Rust | Absolute performance, zero-cost abstractions |
| API | Rust (Axum) | Fast, async, single binary deployment |
| Frontend | React + TypeScript | Best visualization libraries |
| Database | SQLite | Simple, embedded, sufficient for history |
| Deployment | Docker | Single container, bind mount RO |

### Key Libraries

**Rust Backend:**
- `axum` - Web framework
- `axum-extra` - Cookie-based sessions
- `walkdir` - Directory traversal
- `rayon` - Parallel iteration
- `tokio` - Async runtime
- `rusqlite` - SQLite bindings
- `serde` - Serialization
- `argon2` - Password hashing
- `tower` - Middleware (auth layer)

**React Frontend:**
- `react` + `typescript` + `vite`
- `@nivo/treemap` or `d3` - Treemap visualization
- `recharts` or `nivo` - Pie chart
- `zustand` - State management

---

## Scanner Performance Optimizations

### Frontend Performance (Slow Clients / No GPU)
- **Limit initial render:** Show top-level folders + top N largest items, lazy-load deeper levels
- **Canvas instead of SVG:** Use D3 with canvas renderer for large datasets
- **Web Workers:** Move data processing off the main thread
- **Progressive loading:** Show skeleton while loading, then top-level view first

### Scanner Scalability
- **Parallel traversal:** `rayon` for parallel directory walking
- **Depth limits:** Add option to limit scan depth
- **Incremental scans:** Only rescan changed files (store timestamps)
- **Streaming results:** Don't load entire tree into memory - stream to frontend
- **Progress updates:** Long scans show progress

### Scale Guidelines
| Filesystem Size | Expected Performance |
|-----------------|---------------------|
| < 1M files | No issues |
| 1M - 10M files | Need optimization (pagination, depth limits) |
| 10M+ files | Consider partial scans or background processing |

---

## Three-Phase Implementation

### Phase 1: Foundation (MVP)

#### Backend (Rust)
- [ ] Set up Rust project with Cargo
- [ ] Create parallel directory scanner using `walkdir` + `rayon`
- [ ] Implement REST API with Axum framework
- [ ] SQLite database for scan history
- [ ] **Authentication system (see below)**
- [ ] Serve React frontend static files from Rust
- [ ] Docker build configuration

#### Authentication System
- [ ] User registration (admin user creation via CLI or env var)
- [ ] Login/logout with session-based auth (cookies)
- [ ] Password hashing with Argon2
- [ ] Protected routes (require valid session)
- [ ] Session management (expiry, secure cookies)
- [ ] Optional: API key authentication for programmatic access

#### API Endpoints (Public)
- `POST /api/auth/login` - Login (body: `{ "username": "...", "password": "..." }`)
- `POST /api/auth/logout` - Logout
- `GET /api/auth/status` - Check auth status

#### API Endpoints (Protected - require authentication)
- `POST /api/scan` - Start new scan (body: `{ "path": "/scan/root" }`)
- `GET /api/scan/:id` - Get scan results by ID
- `GET /api/scan/:id/tree` - Get directory tree (paginated)
- `GET /api/scan/:id/node/:path` - Get specific node details
- `GET /api/history` - List past scans
- `GET /api/history/:id` - Get historical scan details

#### Frontend (React)
- [ ] Set up React + TypeScript + Vite
- [ ] Create basic layout (sidebar + main content)
- [ ] Connect to backend API
- [ ] **Login page with authentication**
- [ ] Protected routes (redirect to login if not authenticated)
- [ ] Display scan results as file/folder list

#### Docker
- [ ] Multi-stage build
- [ ] Docker Compose for local dev

#### Environment Variables
- `DUC_ADMIN_USERNAME` - Admin username (default: admin)
- `DUC_ADMIN_PASSWORD` - Admin password (required, no default)
- `DUC_SESSION_SECRET` - Secret for session encryption (auto-generated if not set)
- `DUC_SESSION_EXPIRY_HOURS` - Session expiry time in hours (default: 24)

---

### Phase 2: Visualizations

#### Treemap (WizTree-style)
- [ ] Implement treemap using `@nivo/treemap` or D3
- [ ] Color-coded by file type or size
- [ ] Click to drill down into folders
- [ ] Hover tooltips with file/folder details
- [ ] Zoom in/out navigation
- [ ] Breadcrumb navigation
- [ ] Responsive sizing

#### Pie Chart
- [ ] Implement interactive pie/donut chart
- [ ] Show top-level breakdown by folder
- [ ] Click to filter/zoom
- [ ] Legend with percentages

#### View Toggle
- [ ] Switch between treemap and pie chart views
- [ ] Remember user's preference

---

### Phase 3: Advanced Features

#### Advanced Authentication
- [ ] Multiple user support (create/delete users via admin panel)
- [ ] User roles (admin vs viewer)
- [ ] API key management for programmatic access
- [ ] Two-factor authentication (TOTP)
- [ ] Login audit log

#### Remote Scanning (SSH)
- [ ] Add SSH connection configuration
- [ ] Execute scanner on remote via SSH
- [ ] Transfer results back to main API

#### Docker Container Scanning
- [ ] Scan container filesystems
- [ ] Scan Docker volumes
- [ ] Scan images

#### History & Reports
- [ ] Store scan history in SQLite
- [ ] Compare scans (size changes over time)
- [ ] Export to CSV/JSON

#### Modern UI Enhancements
- [ ] Dark mode / theme toggle
- [ ] Responsive design (mobile-friendly)
- [ ] Loading states and progress indicators
- [ ] Search/filter functionality

---

## File Structure

```
/home/coder/duc-reborn/
├── docs/
│   └── PLAN.md
├── backend/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── api/
│   │   │   ├── mod.rs
│   │   │   ├── handlers.rs
│   │   │   ├── models.rs
│   │   │   └── auth.rs
│   │   ├── scanner/
│   │   │   ├── mod.rs
│   │   │   ├── walker.rs
│   │   │   └── types.rs
│   │   ├── db/
│   │   │   ├── mod.rs
│   │   │   └── schema.rs
│   │   └── auth/
│   │       ├── mod.rs
│   │       └── middleware.rs
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Treemap.tsx
│   │   │   ├── PieChart.tsx
│   │   │   ├── FileList.tsx
│   │   │   └── Layout.tsx
│   │   ├── hooks/
│   │   │   └── useScan.ts
│   │   ├── stores/
│   │   │   └── scanStore.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── .dockerignore
├── SPEC.md
└── README.md
```

---

## Quick Start (After Implementation)

```bash
# Build and run
docker-compose up --build

# Access UI
http://localhost:8080

# Start a scan via API
curl -X POST http://localhost:8080/api/scan \
  -H "Content-Type: application/json" \
  -d '{"path": "/data"}'
```

---

## Timeline Estimate

| Phase | Duration | Description |
|-------|----------|-------------|
| Phase 1 | 2-3 days | Foundation - scanner, API, basic frontend |
| Phase 2 | 2-3 days | Visualizations - treemap, pie chart |
| Phase 3 | 3-5 days | Advanced - SSH, Docker scanning, history |

**Total:** ~7-11 days for full implementation