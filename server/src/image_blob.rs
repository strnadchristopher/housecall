//! Shared validation for small profile and server images stored inline in SQLite.
use crate::ApiError;
use axum::http::StatusCode;

pub const MAX_ICON_BYTES: usize = 512 * 1024;
/// Animated GIFs are stored as uploaded, so they get a bigger byte budget but a bounded canvas.
pub const MAX_GIF_BYTES: usize = 2 * 1024 * 1024;
const MAX_GIF_SIDE: u16 = 1024;

fn validate_gif(bytes: &[u8]) -> Result<&'static str, ApiError> {
    if bytes.len() > MAX_GIF_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "GIF must be 2 MB or smaller",
        ));
    }
    // Logical screen width and height: little-endian u16 at bytes 6..8 and 8..10.
    let side = |at: usize| {
        bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    match (side(6), side(8)) {
        (Some(1..=MAX_GIF_SIDE), Some(1..=MAX_GIF_SIDE)) => Ok("image/gif"),
        _ => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "GIF must be between 1 and 1024 pixels on each side",
        )),
    }
}

/// Accepts PNG, JPEG, WebP or GIF by magic bytes; returns the MIME type to serve.
pub fn validate(bytes: &[u8]) -> Result<&'static str, ApiError> {
    if bytes.starts_with(b"GIF8") {
        return validate_gif(bytes);
    }
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
    fn gif(width: u16, height: u16, len: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.resize(len, 0);
        bytes
    }
    #[test]
    fn accepts_a_tiny_gif89a() {
        assert_eq!(validate(&gif(64, 64, 13)).unwrap(), "image/gif");
    }
    #[test]
    fn accepts_a_gif_between_512_kb_and_2_mb() {
        assert_eq!(
            validate(&gif(1024, 1024, MAX_GIF_BYTES)).unwrap(),
            "image/gif"
        );
    }
    #[test]
    fn rejects_a_gif_that_is_too_wide_or_has_no_height_or_is_too_big_or_is_truncated() {
        assert!(validate(&gif(1025, 64, 13)).is_err());
        assert!(validate(&gif(64, 1025, 13)).is_err());
        assert!(validate(&gif(0, 64, 13)).is_err());
        assert!(validate(&gif(64, 0, 13)).is_err());
        assert!(validate(&gif(64, 64, MAX_GIF_BYTES + 1)).is_err());
        assert!(validate(b"GIF89a\x40").is_err());
    }
    #[test]
    fn a_png_over_512_kb_is_still_rejected() {
        let mut png = vec![0x89, b'P', b'N', b'G'];
        png.resize(MAX_ICON_BYTES + 1, 0);
        assert!(validate(&png).is_err());
    }
}
