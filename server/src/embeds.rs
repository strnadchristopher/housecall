//! Text-only link metadata. Untrusted HTML/URLs never become active client markup.
use crate::{ApiError, ApiResult, AppState};
use axum::{extract::Query, http::StatusCode, routing::get, Json, Router};
use reqwest::{Client, Url};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

const HTML_LIMIT: usize = 512 * 1024;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub fn routes() -> Router<AppState> {
    Router::new().route("/embeds", get(preview))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    url: String,
}
#[derive(Debug, Serialize)]
struct Preview {
    url: String,
    hostname: String,
    title: String,
    description: String,
}
fn invalid() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "only public HTTPS links on port 443 can be previewed",
    )
}
fn upstream() -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, "link preview unavailable")
}

fn ipv4_public(ip: Ipv4Addr) -> bool {
    let x = u32::from(ip);
    // Conservative denylist: private, loopback, link-local, carrier NAT, benchmark,
    // documentation, multicast, reserved, and special-purpose protocol ranges.
    let denied: &[(u32, u32)] = &[
        (0x00000000, 8),
        (0x0a000000, 8),
        (0x64400000, 10),
        (0x7f000000, 8),
        (0xa9fe0000, 16),
        (0xac100000, 12),
        (0xc0000000, 24),
        (0xc0000200, 24),
        (0xc0586300, 24),
        (0xc0a80000, 16),
        (0xc6120000, 15),
        (0xc6336400, 24),
        (0xcb007100, 24),
        (0xe0000000, 3),
    ];
    !denied
        .iter()
        .any(|(base, bits)| x >> (32 - bits) == base >> (32 - bits))
}
fn ipv6_public(ip: Ipv6Addr) -> bool {
    let n = u128::from(ip);
    // Only native global unicast; excludes mapped IPv4, NAT64, 6to4, Teredo,
    // ULA, link-local, multicast and IETF/docs special-purpose prefixes.
    n >> 125 == 1
        && n >> 105 != u128::from("2001::".parse::<Ipv6Addr>().unwrap()) >> 105
        && n >> 96 != u128::from("2001:db8::".parse::<Ipv6Addr>().unwrap()) >> 96
        && n >> 112 != 0x2002
        && n >> 108 != u128::from("3fff::".parse::<Ipv6Addr>().unwrap()) >> 108
}
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ipv4_public(ip),
        IpAddr::V6(ip) => ipv6_public(ip),
    }
}
fn validated_url(input: &str) -> Result<Url, ApiError> {
    if input.len() > 2048 || input.chars().any(char::is_control) {
        return Err(invalid());
    }
    let mut url = Url::parse(input).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    match url.host().ok_or_else(invalid)? {
        url::Host::Ipv4(ip) if !ipv4_public(ip) => return Err(invalid()),
        url::Host::Ipv6(ip) if !ipv6_public(ip) => return Err(invalid()),
        url::Host::Domain(host) => {
            let host = host.trim_end_matches('.');
            if !host.contains('.')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "home",
                    "test",
                    "invalid",
                    "onion",
                ]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
            {
                return Err(invalid());
            }
        }
        _ => {}
    }
    url.set_fragment(None);
    Ok(url)
}
fn select_address(addresses: &[SocketAddr]) -> Result<SocketAddr, ApiError> {
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses.iter().any(|a| a.port() != 443 || !public(a.ip()))
    {
        return Err(invalid());
    }
    Ok(addresses[0])
}
fn safe_client(host: &str, address: SocketAddr) -> Result<Client, ApiError> {
    Client::builder()
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .resolve(host, address)
        .user_agent("Chriscord-LinkPreview/0.1")
        .build()
        .map_err(|_| upstream())
}
async fn preview(Query(request): Query<Request>) -> ApiResult<Preview> {
    let _permit = SLOTS
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "link previews busy"))?;
    let url = validated_url(&request.url)?;
    let host = url.host_str().ok_or_else(invalid)?.to_owned();
    let addresses = match url.host().ok_or_else(invalid)? {
        url::Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), 443)],
        url::Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), 443)],
        url::Host::Domain(domain) => tokio::time::timeout(
            Duration::from_secs(3),
            tokio::net::lookup_host((domain, 443)),
        )
        .await
        .map_err(|_| upstream())?
        .map_err(|_| upstream())?
        .take(65)
        .collect(),
    };
    // All answers must be public; pin the chosen answer so a second lookup cannot rebind.
    let address = select_address(&addresses)?;
    let mut response = safe_client(&host, address)?
        .get(url.clone())
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|_| upstream())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > HTML_LIMIT as u64)
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| {
                !v.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("text/html")
            })
    {
        return Err(upstream());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if body.len().saturating_add(chunk.len()) > HTML_LIMIT {
            return Err(upstream());
        }
        body.extend_from_slice(&chunk);
    }
    let result = tokio::task::spawn_blocking(move || extract(url, &String::from_utf8_lossy(&body)))
        .await
        .map_err(|_| upstream())?;
    Ok(Json(result))
}
fn text(input: &str, limit: usize) -> String {
    input
        .chars()
        .filter(|c| !c.is_control() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}
fn extract(url: Url, html: &str) -> Preview {
    let doc = Html::parse_document(html);
    let mut title = String::new();
    let mut description = String::new();
    for el in doc.select(&Selector::parse("meta").unwrap()) {
        let key = el
            .value()
            .attr("property")
            .or_else(|| el.value().attr("name"))
            .unwrap_or("");
        let value = el.value().attr("content").unwrap_or("");
        if key.eq_ignore_ascii_case("og:title") && title.is_empty() {
            title = text(value, 200)
        }
        if (key.eq_ignore_ascii_case("og:description") || key.eq_ignore_ascii_case("description"))
            && description.is_empty()
        {
            description = text(value, 500)
        }
    }
    if title.is_empty() {
        if let Some(el) = doc.select(&Selector::parse("title").unwrap()).next() {
            title = text(&el.text().collect::<String>(), 200)
        }
    }
    let hostname = url.host_str().unwrap_or("").to_owned();
    if title.is_empty() {
        title = hostname.clone();
    }
    Preview {
        url: url.into(),
        hostname,
        title,
        description,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn forbidden_url_variants() {
        for url in [
            "http://example.com",
            "https://example.com:444/",
            "https://user:pass@example.com/",
            "https://localhost/",
            "https://metadata.google.internal/",
            "https://127.1/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://169.254.169.254/latest/meta-data/",
            "https://100.100.100.200/",
            "https://192.168.1.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[64:ff9b::7f00:1]/",
            "https://[2002:7f00:1::]/",
            "https://[2001:db8::1]/",
            "https://[3fff::1]/",
            "https://example.com\n/",
        ] {
            assert!(validated_url(url).is_err(), "{url}");
        }
        assert!(validated_url("https://example.com/path?q=yes#section").is_ok());
    }
    #[test]
    fn mixed_public_private_dns_is_rejected() {
        let good = "8.8.8.8:443".parse().unwrap();
        for bad in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "[fc00::1]:443",
            "[fe80::1]:443",
            "192.0.2.2:443",
        ] {
            assert!(select_address(&[good, bad.parse().unwrap()]).is_err())
        }
        assert_eq!(select_address(&[good]).unwrap(), good);
        assert!(select_address(&[]).is_err());
        assert!(public("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn metadata_has_no_active_html_or_external_resources() {
        let value=extract(Url::parse("https://example.com/").unwrap(),"<title>Fallback &amp; text</title><meta property='og:title' content='&lt;img src=x onerror=alert(1)&gt;'><meta name='description' content='Hello    world'><meta property='og:image' content='http://127.0.0.1/secret'><script>bad()</script><link rel='canonical' href='http://evil'>");
        assert_eq!(value.title, "<img src=x onerror=alert(1)>"); // Plain JSON text: presentation must render as text.
        assert_eq!(value.description, "Hello world");
        let json = serde_json::to_string(&value).unwrap();
        assert!(!json.contains("127.0.0.1"));
        assert!(!json.contains("bad()"));
        assert!(!json.contains("http://evil"));
    }
    proptest! {
        #[test] fn parser_never_emits_unbounded_fields(html in ".{0,4096}") {
            let p=extract(Url::parse("https://example.com").unwrap(),&html);
            prop_assert!(p.title.chars().count()<=200);prop_assert!(p.description.chars().count()<=500);
        }
        #[test] fn private_ipv4_never_passes(a in any::<u8>(),b in any::<u8>(),c in any::<u8>()) { prop_assert!(!public(IpAddr::V4(Ipv4Addr::new(10,a,b,c))));prop_assert!(!public(IpAddr::V4(Ipv4Addr::new(127,a,b,c)))); }
    }
}
