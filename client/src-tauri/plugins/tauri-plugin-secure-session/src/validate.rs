//! Input checks shared by every platform. The web side is trusted no further than this: only a
//! server origin and four known session fields can be stored, whatever else is sent.
use serde_json::{json, Map, Value};

const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// `https://host[:port]`, or `http://` on loopback only. No credentials, path, query or fragment.
pub fn origin(value: &str) -> Result<&str, &'static str> {
    const INVALID: &str = "invalid server origin";
    if value.is_empty() || value.len() > 200 {
        return Err(INVALID);
    }
    let (secure, rest) = if let Some(rest) = value.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(INVALID);
    };
    if rest.is_empty()
        || !rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'-' | b'[' | b']'))
    {
        return Err(INVALID);
    }
    let host = if rest.starts_with('[') {
        rest.split_once(']').map_or(rest, |(h, _)| &rest[..h.len() + 1])
    } else {
        rest.split(':').next().unwrap_or(rest)
    };
    if !secure && !LOOPBACK.contains(&host) {
        return Err(INVALID);
    }
    Ok(value)
}

fn text(map: &Map<String, Value>, key: &str, max: usize) -> Result<String, &'static str> {
    match map.get(key) {
        Some(Value::String(s)) if !s.is_empty() && s.len() <= max => Ok(s.clone()),
        _ => Err("invalid session"),
    }
}

/// Keeps only `{token, device_key, username, expires_at}`.
pub fn session(value: &Value) -> Result<Value, &'static str> {
    let map = value.as_object().ok_or("invalid session")?;
    let token = text(map, "token", 256)?;
    let device_key = text(map, "device_key", 256)?;
    let username = text(map, "username", 64)?;
    let expires_at = map
        .get("expires_at")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or("invalid session")?;
    Ok(json!({"token":token,"device_key":device_key,"username":username,"expires_at":expires_at}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        for ok in ["https://chat.example.test", "https://a.test:8443", "http://localhost:1420", "http://127.0.0.1:3031", "http://[::1]:3000"] {
            assert!(origin(ok).is_ok(), "{ok}");
        }
        for bad in ["", "http://chat.example.test", "https://u:p@a.test", "https://a.test/x", "https://a.test?x", "ftp://a.test", "https://", "https://a b.test"] {
            assert!(origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn sessions_keep_only_known_fields() {
        let ok = session(&json!({"token":"t","device_key":"d","username":"kim","expires_at":5,"extra":"x"})).unwrap();
        assert_eq!(ok, json!({"token":"t","device_key":"d","username":"kim","expires_at":5}));
        assert!(session(&json!({"token":"t"})).is_err());
        assert!(session(&json!("nope")).is_err());
        assert!(session(&json!({"token":"t","device_key":"d","username":"kim","expires_at":-1})).is_err());
    }
}

/// Install identity, word-confirmation gate, and optional crash-replay pin journal.
pub fn identity(value: &Value) -> Result<Value, &'static str> {
    let seed = value.get("seed").and_then(Value::as_str).ok_or("invalid identity")?;
    if seed.len() != 43 || !seed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') || !b"AEIMQUYcgkosw048".contains(&seed.as_bytes()[42]) { return Err("invalid identity"); }
    let rev = value.get("recovery_rev").and_then(Value::as_u64).filter(|r| *r > 0 && *r <= u32::MAX as u64).ok_or("invalid identity")?;
    let confirmed = value.get("confirmed").and_then(Value::as_bool).ok_or("invalid identity")?;
    let words_require_password = value.get("words_require_password").and_then(Value::as_bool).unwrap_or(false);
    let mut record = json!({"seed":seed,"recovery_rev":rev,"confirmed":confirmed,"words_require_password":words_require_password});
    if let Some(journal) = value.get("pin_import") {
        let updates = journal.as_array().filter(|v| v.len() <= 1000).ok_or("invalid pin import")?;
        if journal.to_string().len() > 4_000_000 { return Err("invalid pin import"); }
        for update in updates {
            let host = update.get("origin").and_then(Value::as_str).ok_or("invalid pin import")?;
            origin(host)?;
            let account = update.get("account").and_then(Value::as_str).ok_or("invalid pin import")?;
            if account.is_empty() || account.len() > 128 || account.chars().any(char::is_control) { return Err("invalid pin import"); }
            let pins = update.get("pins").and_then(Value::as_array).ok_or("invalid pin import")?;
            for pin in pins {
                if pin.get("origin").and_then(Value::as_str) != Some(host) || !pin.get("history").is_some_and(Value::is_array) { return Err("invalid pin import"); }
            }
        }
        record["pin_import"] = journal.clone();
    }
    Ok(record)
}

#[cfg(test)]
mod import_tests {
    use super::*;
    #[test]
    fn identity_preserves_durable_import_gate() {
        let mut raw = json!({"seed":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","recovery_rev":1,"confirmed":true,
            "pin_import":[{"origin":"https://chat.example.test","account":"me","pins":[]} ]});
        assert_eq!(identity(&raw).unwrap()["pin_import"], raw["pin_import"]);
        raw["pin_import"][0]["origin"] = json!("http://remote.test");
        assert!(identity(&raw).is_err());
        raw["pin_import"] = Value::Null;
        assert!(identity(&raw).is_err());
    }
}
