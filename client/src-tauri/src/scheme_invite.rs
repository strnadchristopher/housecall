//! `housecall://invite?code=<hc1 code>` delivered by the OS (iOS through CFBundleURLTypes, `RunEvent::Opened`).
//! One short-lived pending URL, taken once by the web layer (`transport/deepLinks.ts`), which parses it strictly
//! and only prefills Join (signed out) or asks before joining (signed in). Never logged or persisted.
//! Android delivers the same scheme through `InviteLinkInbox.kt` and `native_auth`.
// Only iOS and macOS receive RunEvent::Opened; elsewhere the inbox stays empty and only `take` runs.
#![cfg_attr(not(any(target_os = "ios", target_os = "macos")), allow(dead_code))]
use std::sync::Mutex;
use std::time::{Duration, Instant};

static INBOX: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(120);

/// Shape check only (the web layer decodes the code): exact prefix, a bounded code alphabet, nothing after it.
fn accepted(url: &str) -> bool {
    url.len() <= 2048
        && url.strip_prefix("housecall://invite?code=").is_some_and(|code| {
            code.starts_with("hc1.")
                && code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

/// Keeps the newest acceptable URL; anything else is dropped silently.
pub fn capture<'a>(urls: impl IntoIterator<Item = &'a str>) {
    if let Some(url) = urls.into_iter().filter(|url| accepted(url)).last() {
        if let Ok(mut inbox) = INBOX.lock() {
            *inbox = Some((url.to_owned(), Instant::now()));
        }
    }
}

fn take() -> Option<String> {
    let mut inbox = INBOX.lock().ok()?;
    let (url, at) = inbox.take()?;
    (at.elapsed() <= TTL).then_some(url)
}

/// `{ "url": "housecall://invite?code=…" }` once, then `{ "url": null }`.
#[tauri::command]
pub fn scheme_invite_take() -> serde_json::Value {
    serde_json::json!({ "url": take() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_invite_shape_and_hands_it_out_once() {
        let good = format!("housecall://invite?code=hc1.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA.{}", "ab".repeat(32));
        capture(["https://example.test/", "housecall://evil?code=hc1.x", "housecall://invite?code=hc1.a&next=x", good.as_str()]);
        assert_eq!(take().as_deref(), Some(good.as_str()));
        assert_eq!(take(), None);
        capture(["housecall://invite?code=nothc1"]);
        assert_eq!(take(), None);
    }
}
