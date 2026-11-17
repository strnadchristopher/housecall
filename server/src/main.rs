use housecall_server::{app, AppState, InviteMailConfig};
mod media_limits;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let token = std::env::var("HOUSECALL_SETUP_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    if token.as_ref().is_some_and(|token| token.len() < 32) {
        return Err("HOUSECALL_SETUP_TOKEN must have at least 32 characters".into());
    }
    let database =
        std::env::var("HOUSECALL_DATABASE").unwrap_or_else(|_| "data/housecall.sqlite".into());
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
    let mut state = AppState::new_with_setup_token(&database, token.as_deref())?;
    state.invite_mail =
        std::sync::Arc::new(InviteMailConfig::from_env().map_err(std::io::Error::other)?);
    if let Ok(origins) = std::env::var("HOUSECALL_CLIENT_ORIGINS") {
        for origin in origins.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if origin == "*" {
                return Err("wildcard client origins are forbidden".into());
            }
            state.client_origins.push(origin.parse()?);
        }
    }
    if let Ok(origin) = std::env::var("HOUSECALL_ORIGIN") {
        state.passkeys = Some(std::sync::Arc::new(
            housecall_server::passkeys::Passkeys::with_android_origins(
                &origin,
                &std::env::var("HOUSECALL_ANDROID_PASSKEY_ORIGINS")
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )?,
        ));
    }
    let media_limits = media_limits::from_env().map_err(std::io::Error::other)?;
    if let Ok(key) = std::env::var("HOUSECALL_MEDIA_KEY") {
        let key: [u8; 32] = hex::decode(key)?
            .try_into()
            .map_err(|_| "HOUSECALL_MEDIA_KEY must be 64 hex characters")?;
        let path = std::env::var("HOUSECALL_MEDIA_DIR").unwrap_or_else(|_| "data/media".into());
        state.media = Some(std::sync::Arc::new(housecall_media::Store::with_limits(
            path,
            key,
            media_limits,
        )?));
    }
    let scanner_engine =
        std::env::var("HOUSECALL_MEDIA_SCANNER").unwrap_or_else(|_| "clamav".into());
    let scan_timeout: u64 = std::env::var("HOUSECALL_SCAN_TIMEOUT_SECONDS")
        .unwrap_or_else(|_| "300".into())
        .parse()
        .map_err(|_| "HOUSECALL_SCAN_TIMEOUT_SECONDS must be an integer from 1 to 86400")?;
    if !(1..=86400).contains(&scan_timeout) {
        return Err("HOUSECALL_SCAN_TIMEOUT_SECONDS must be from 1 to 86400".into());
    }
    let timeout = std::time::Duration::from_secs(scan_timeout);
    match scanner_engine.as_str() {
        "clamav" =>
        {
            #[cfg(unix)]
            if let Ok(socket) = std::env::var("HOUSECALL_CLAMD_SOCKET") {
                state.scanner = std::sync::Arc::new(housecall_media::ClamdScanner {
                    socket: socket.into(),
                    timeout,
                });
            }
        }
        "withsecure" => {
            #[cfg(target_os = "linux")]
            {
                let binary = std::env::var("HOUSECALL_FSANALYZE").map_err(|_| {
                    "HOUSECALL_FSANALYZE must name the provisioned absolute executable"
                })?;
                state.scanner = std::sync::Arc::new(housecall_media::WithSecureScanner::new(
                    binary.into(),
                    timeout,
                )?);
            }
            #[cfg(not(target_os = "linux"))]
            return Err("withsecure scanning requires Linux".into());
        }
        _ => return Err("HOUSECALL_MEDIA_SCANNER must be clamav or withsecure".into()),
    }
    housecall_server::vm::configure(&mut state)?;
    housecall_server::vm_media::configure(&mut state)?;
    housecall_server::voice::configure(&mut state)?;
    housecall_server::voice::spawn_sweeper(&state);
    housecall_server::vm_media::start(&state).await?;
    housecall_server::transcode::configure(&mut state)?;
    housecall_server::plex::configure(&mut state)?;
    housecall_server::gimme::configure(&mut state)?;
    housecall_server::gimme::spawn_worker(&state);
    housecall_server::dj::configure(&mut state)?;
    housecall_server::dj::spawn_worker(&state);
    housecall_server::push::configure(&mut state)?;
    housecall_server::push::spawn_worker(&state);
    housecall_server::snaps::spawn_reaper(&state);
    let static_dir = std::env::var("HOUSECALL_STATIC_DIR").unwrap_or_else(|_| "client/dist".into());
    let bind = std::env::var("HOUSECALL_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%listener.local_addr()?,"Housecall listening");
    axum::serve(listener, app(state, Some(&static_dir)))
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}
