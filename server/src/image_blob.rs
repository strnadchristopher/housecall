//! Shared validation for small profile and server images stored inline in SQLite.
use crate::ApiError;
use axum::http::StatusCode;

pub const MAX_ICON_BYTES: usize = 512 * 1024;

/// Accepts PNG, JPEG, WebP or GIF by magic bytes; returns the MIME type to serve.
pub fn validate(bytes: &[u8]) -> Result<&'static str, ApiError> {
    if bytes.len() > MAX_ICON_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "image must be 512 KB or smaller",
        ));
    }
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Ok("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Ok("image/jpeg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Ok("image/webp"),
        [b'G', b'I', b'F', b'8', ..] => Ok("image/gif"),
        _ => Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "use a PNG, JPEG, WebP or GIF image",
        )),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_png() {
        assert_eq!(
            validate(&[0x89, b'P', b'N', b'G', 0, 0]).unwrap(),
            "image/png"
        );
    }
    #[test]
    fn rejects_svg() {
        assert!(validate(b"<svg xmlns").is_err());
    }
    #[test]
    fn rejects_large() {
        assert!(validate(&vec![0xFF; MAX_ICON_BYTES + 1]).is_err());
    }
}
