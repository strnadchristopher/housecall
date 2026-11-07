FROM node:22-bookworm-slim AS client
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM rust:1.98-bookworm AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY server/ ./server/
COPY crates/media/ ./crates/media/
RUN cargo build --locked --release -p chriscord-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home chriscord && mkdir -p /data && chown 10001:10001 /data
COPY --from=server /build/target/release/chriscord-server /usr/local/bin/chriscord-server
COPY --from=client /build/client/dist /app/client
USER 10001:10001
ENV CHRISCORD_BIND=0.0.0.0:3000 CHRISCORD_DATABASE=/data/chriscord.sqlite CHRISCORD_STATIC_DIR=/app/client CHRISCORD_MEDIA_DIR=/data/media
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail --silent http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["chriscord-server"]
