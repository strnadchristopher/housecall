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
COPY crates/ ./crates/
ENV CARGO_BUILD_JOBS=1
# COPY preserves source mtimes; invalidate local crates so a newer target cache cannot hide edits.
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo clean --release -p chriscord-server -p chriscord-activities -p chriscord-media -p chriscord-sfu && cargo build --locked --release -p chriscord-server && cp /build/target/release/chriscord-server /build/chriscord-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 espeak-ng && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home chriscord && mkdir -p /data && chown 10001:10001 /data
# Official zipimport release bundles EJS; no runtime download of executable solver code.
RUN curl --fail --location --retry 2 https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp -o /usr/local/bin/yt-dlp && echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/bin/yt-dlp' | sha256sum --check && chmod 0755 /usr/local/bin/yt-dlp
COPY --from=client /usr/local/bin/node /usr/local/bin/node
COPY --from=server /build/chriscord-server /usr/local/bin/chriscord-server
COPY --from=client /build/client/dist /app/client
USER 10001:10001
ENV CHRISCORD_BIND=0.0.0.0:3000 CHRISCORD_DATABASE=/data/chriscord.sqlite CHRISCORD_STATIC_DIR=/app/client CHRISCORD_MEDIA_DIR=/data/media
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail --silent http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["chriscord-server"]
