use chriscord_server::{app, AppState};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let token =
        std::env::var("CHRISCORD_SETUP_TOKEN").map_err(|_| "CHRISCORD_SETUP_TOKEN must be set")?;
    if token.len() < 32 {
        return Err("CHRISCORD_SETUP_TOKEN must have at least 32 characters".into());
    }
    let database =
        std::env::var("CHRISCORD_DATABASE").unwrap_or_else(|_| "data/chriscord.sqlite".into());
    if let Some(parent) = std::path::Path::new(&database)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&database)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    let mut state = AppState::new(&database, &token)?;
    if let Ok(origins) = std::env::var("CHRISCORD_CLIENT_ORIGINS") {
        for origin in origins.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if origin == "*" {
                return Err("wildcard client origins are forbidden".into());
            }
            state.client_origins.push(origin.parse()?);
        }
    }
    if let Ok(origin) = std::env::var("CHRISCORD_ORIGIN") {
        state.passkeys = Some(std::sync::Arc::new(
            chriscord_server::passkeys::Passkeys::new(&origin)?,
        ));
    }
    if let Ok(key) = std::env::var("CHRISCORD_MEDIA_KEY") {
        let key: [u8; 32] = hex::decode(key)?
            .try_into()
            .map_err(|_| "CHRISCORD_MEDIA_KEY must be 64 hex characters")?;
        let path = std::env::var("CHRISCORD_MEDIA_DIR").unwrap_or_else(|_| "data/media".into());
        state.media = Some(std::sync::Arc::new(chriscord_media::Store::new(path, key)?));
    }
    #[cfg(unix)]
    if let Ok(socket) = std::env::var("CHRISCORD_CLAMD_SOCKET") {
        state.scanner = std::sync::Arc::new(chriscord_media::ClamdScanner {
            socket: socket.into(),
            timeout: std::time::Duration::from_secs(300),
        });
    }
    chriscord_server::voice::configure(&mut state)?;
    chriscord_server::transcode::configure(&mut state)?;
    chriscord_server::plex::configure(&mut state)?;
    chriscord_server::gimme::configure(&mut state)?;
    chriscord_server::gimme::spawn_worker(&state);
    chriscord_server::dj::configure(&mut state)?;
    chriscord_server::dj::spawn_worker(&state);
    let static_dir = std::env::var("CHRISCORD_STATIC_DIR").unwrap_or_else(|_| "client/dist".into());
    let bind = std::env::var("CHRISCORD_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%listener.local_addr()?,"Chriscord listening");
    axum::serve(listener, app(state, Some(&static_dir)))
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}
