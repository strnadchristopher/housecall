//! Authenticated Giphy proxy. Provider URLs are fixed and never supplied by clients.
use crate::{ApiError, ApiResult, AppState};
use axum::{
    extract::{Path, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.giphy.com/v1/gifs/search";
const MEDIA: &str = "https://media.giphy.com/";
const JSON_LIMIT: usize = 2 * 1024 * 1024;
const MEDIA_LIMIT: usize = 32 * 1024 * 1024;
static MEDIA_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/giphy/search", get(search))
        .route("/giphy/media/{id}", get(media))
}
pub fn configured() -> bool {
    std::env::var("GIPHY_API_KEY").is_ok_and(|s| !s.trim().is_empty())
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "Giphy is not configured")
}
fn upstream() -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "Giphy could not complete this request",
    )
}
fn client() -> Result<Client, ApiError> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .user_agent("Chriscord/0.1")
        .build()
        .map_err(|_| upstream())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    q: String,
    #[serde(default)]
    offset: u16,
}
fn valid_query(q: &str) -> bool {
    !q.trim().is_empty() && q.len() <= 200 && !q.chars().any(char::is_control)
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ApiError> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > limit as u64)
    {
        return Err(upstream());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if data
            .len()
            .checked_add(chunk.len())
            .is_none_or(|len| len > limit)
        {
            return Err(upstream());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn search(Query(query): Query<Search>) -> ApiResult<Value> {
    if !valid_query(&query.q) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid Giphy search"));
    }
    let key = std::env::var("GIPHY_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(unavailable)?;
    let response = client()?
        .get(API)
        .query(&[
            ("api_key", key),
            ("q", query.q),
            ("limit", "20".into()),
            ("offset", query.offset.to_string()),
            ("rating", "pg-13".into()),
        ])
        .send()
        .await
        .map_err(|_| upstream())?;
    let value: Value =
        serde_json::from_slice(&bounded(response, JSON_LIMIT).await?).map_err(|_| upstream())?;
    Ok(Json(sanitize_results(&value, query.offset)?))
}
fn sanitize_results(value: &Value, offset: u16) -> Result<Value, ApiError> {
    let rows = value["data"].as_array().ok_or_else(upstream)?;
    let mut results = vec![];
    for row in rows.iter().take(20) {
        let Some(id) = row["id"].as_str().filter(|id| valid_id(id)) else {
            continue;
        };
        let title = row["title"]
            .as_str()
            .unwrap_or("GIF")
            .chars()
            .take(200)
            .collect::<String>();
        // Never forward supplied provider image URLs, HTML, tracking parameters or credentials.
        results.push(json!({"id":id,"title":title,"media_path":format!("/api/giphy/media/{id}"),"source_url":format!("https://giphy.com/gifs/{id}")}));
    }
    let count = rows.len().min(20) as u64;
    let total = value["pagination"]["total_count"]
        .as_u64()
        .unwrap_or(u64::from(offset) + count);
    Ok(
        json!({"results":results,"attribution":"Powered by GIPHY","next_offset":if count>0 && u64::from(offset)+count<total {Some(u64::from(offset)+count)}else{None}}),
    )
}
async fn media(Path(id): Path<String>) -> Result<Response, ApiError> {
    let _slot = MEDIA_SLOTS
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "Giphy media is busy"))?;
    if !valid_id(&id) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid Giphy id"));
    }
    if !configured() {
        return Err(unavailable());
    }
    let mut url = Url::parse(MEDIA).map_err(|_| upstream())?;
    url.set_path(&format!("/media/{id}/giphy.mp4"));
    let response = client()?.get(url).send().await.map_err(|_| upstream())?;
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v.split(';').next() != Some("video/mp4"))
    {
        return Err(upstream());
    }
    let bytes = bounded(response, MEDIA_LIMIT).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "video/mp4"),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn malicious_provider_urls_never_cross_boundary() {
        let input = json!({"data":[{"id":"abc123","title":"<img src=x onerror=evil()>","images":{"original":{"url":"http://169.254.169.254/secrets"}}},{"id":"../secret"},{"id":"http://localhost"}],"pagination":{"total_count":100}});
        let result = sanitize_results(&input, 0).unwrap();
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["results"][0]["media_path"],
            "/api/giphy/media/abc123"
        );
        assert!(!result.to_string().contains("169.254"));
        assert_eq!(result["attribution"], "Powered by GIPHY");
    }
    #[test]
    fn query_and_media_boundaries() {
        for id in [
            "",
            "../x",
            "a/b",
            "a?x=1",
            "127.0.0.1",
            "a%2fb",
            "a\\b",
            "https://evil",
        ] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("AbC123"));
        assert!(!valid_query("\n"));
        assert!(!valid_query(&"x".repeat(201)));
    }
    proptest! { #[test] fn accepted_ids_cannot_change_origin(id in ".{0,100}") { if valid_id(&id) { let url=Url::parse(&format!("{MEDIA}media/{id}/giphy.mp4")).unwrap();prop_assert_eq!(url.host_str(),Some("media.giphy.com"));prop_assert_eq!(url.scheme(),"https");prop_assert_eq!(url.path_segments().unwrap().count(),3); } } }
}
