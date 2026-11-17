//! Production media admission configuration. No environment value enables unlimited mode.
use housecall_media::Limits;

pub fn from_env() -> Result<Limits, String> {
    parse(|name| match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(format!("{name} must be valid UTF-8")),
    })
}
fn parse(mut get: impl FnMut(&str) -> Result<Option<String>, String>) -> Result<Limits, String> {
    fn value(
        get: &mut impl FnMut(&str) -> Result<Option<String>, String>,
        name: &str,
        default: u64,
    ) -> Result<u64, String> {
        let Some(raw) = get(name)? else {
            return Ok(default);
        };
        if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!(
                "{name} must be a positive decimal integer below u64::MAX"
            ));
        }
        raw.parse::<u64>()
            .ok()
            .filter(|n| *n > 0 && *n < u64::MAX)
            .ok_or_else(|| format!("{name} must be a positive decimal integer below u64::MAX"))
    }
    let limits = Limits {
        total_bytes: value(
            &mut get,
            "HOUSECALL_MEDIA_TOTAL_BYTES",
            20 * 1024 * 1024 * 1024,
        )?,
        owner_bytes: value(
            &mut get,
            "HOUSECALL_MEDIA_OWNER_BYTES",
            4 * 1024 * 1024 * 1024,
        )?,
        upload_bytes: value(
            &mut get,
            "HOUSECALL_MEDIA_UPLOAD_BYTES",
            2 * 1024 * 1024 * 1024,
        )?,
        pending_per_owner: value(&mut get, "HOUSECALL_MEDIA_PENDING_PER_OWNER", 16)?,
        uploads: value(&mut get, "HOUSECALL_MEDIA_MAX_UPLOADS", 10_000)?,
    };
    if limits.upload_bytes > limits.owner_bytes || limits.owner_bytes > limits.total_bytes {
        return Err("media budgets must satisfy upload <= owner <= total".into());
    }
    if limits.pending_per_owner > limits.uploads {
        return Err("media pending count must not exceed total upload count".into());
    }
    Ok(limits)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_finite_and_invalid_configuration_fails_closed() {
        let defaults = parse(|_| Ok(None)).unwrap();
        assert_eq!(defaults.total_bytes, 20 * 1024 * 1024 * 1024);
        assert_eq!(defaults.owner_bytes, 4 * 1024 * 1024 * 1024);
        assert_eq!(defaults.upload_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(defaults.pending_per_owner, 16);
        assert_eq!(defaults.uploads, 10_000);
        for raw in [
            "",
            "0",
            "-1",
            "+1",
            " 12",
            "1GiB",
            "18446744073709551615",
            "18446744073709551616",
        ] {
            assert!(parse(|_| Ok(Some(raw.into()))).is_err(), "{raw}");
        }
        assert!(
            parse(|name| Ok((name == "HOUSECALL_MEDIA_OWNER_BYTES").then(|| "1".into()))).is_err()
        );
        assert!(
            parse(|name| Ok((name == "HOUSECALL_MEDIA_MAX_UPLOADS").then(|| "1".into()))).is_err()
        );
        let tiny = parse(|name| {
            Ok(Some(
                match name {
                    "HOUSECALL_MEDIA_TOTAL_BYTES" => "12",
                    "HOUSECALL_MEDIA_OWNER_BYTES" => "8",
                    "HOUSECALL_MEDIA_UPLOAD_BYTES" => "6",
                    "HOUSECALL_MEDIA_PENDING_PER_OWNER" => "2",
                    _ => "4",
                }
                .into(),
            ))
        })
        .unwrap();
        assert_eq!(tiny.upload_bytes, 6);
    }
}
