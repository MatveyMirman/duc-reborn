# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

# Stage 2: Build backend
FROM rust:1.88 AS backend
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN cargo build --release

# Stage 3: Final runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/duc-reborn /app/
COPY --from=frontend /app/dist/ /app/dist/
RUN mkdir -p /data

EXPOSE 8080
ENV RUST_LOG=info

CMD ["/app/duc-reborn"]