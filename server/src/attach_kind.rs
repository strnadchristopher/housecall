/// Display kind for an attachment, decided from the stored filename and whether a
/// transcode is ready. Rendering hint only: bytes are still scanned and served as before.
pub fn kind(filename: &str, video_ready: bool) -> &'static str {
    if video_ready {
        return "video";
    }
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "avif" => "image",
        "gif" => "gif",
        "mp4" | "mov" | "m4v" | "webm" | "mkv" => "video_pending",
        _ => "file",
    }
}
#[cfg(test)]
mod tests {
    use super::kind;
    #[test]
    fn classifies() {
        assert_eq!(kind("a.PNG", false), "image");
        assert_eq!(kind("x.gif", false), "gif");
        assert_eq!(kind("clip.mov", false), "video_pending");
        assert_eq!(kind("clip.mov", true), "video");
        assert_eq!(kind("notes.pdf", false), "file");
        assert_eq!(kind("noext", false), "file");
    }
}
