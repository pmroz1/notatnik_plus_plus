# syntax=docker/dockerfile:1

# ---- Frontend build ----
FROM node:22.23-bookworm-slim AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

# ---- API build ----
FROM rust:1.99-bookworm AS api
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/api ./apps/api
RUN cargo build --release --locked -p notes-api

# ---- Runtime ----
FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 notes \
    && useradd --system --uid 10001 --gid notes --home-dir /data --shell /usr/sbin/nologin notes \
    && mkdir -p /data /app \
    && chown notes:notes /data
COPY --from=api /src/target/release/notes-api /usr/local/bin/notes-api
COPY --from=web /src/apps/web/dist/web/browser /app/web

ENV NOTES_DATA_DIR=/data \
    NOTES_STATIC_DIR=/app/web \
    NOTES_BIND=0.0.0.0:8080 \
    RUST_LOG=info

USER notes
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["notes-api"]
CMD ["serve"]
