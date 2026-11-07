//! Authenticated, revisioned activities and server-only provider adapters.
//! The embedding server owns authentication, voice membership, persistence and broadcast.
pub mod dj;
pub mod gimme;
pub mod plex;
pub mod session;

pub use session::{Command, Kind, Session, Snapshot};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a member of this voice activity")]
    Forbidden,
    #[error("stale activity revision")]
    Conflict,
    #[error("invalid activity command: {0}")]
    Invalid(&'static str),
    #[error("provider unavailable or returned invalid data")]
    Provider,
    #[error("local process failed or timed out")]
    Process,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Every provider client disables redirects so credentials stay on the configured origin.
pub(crate) fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Provider)
}
pub(crate) fn origin(raw: &str) -> Result<url::Url> {
    let u = url::Url::parse(raw).map_err(|_| Error::Invalid("provider origin"))?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(Error::Invalid("provider origin"));
    }
    Ok(u)
}

/// Bounded metadata response reader, including chunked responses without Content-Length.
pub async fn read_json(mut response: reqwest::Response, limit: usize) -> Result<serde_json::Value> {
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err(Error::Provider);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Provider)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(Error::Provider);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Provider)
}
