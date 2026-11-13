use tauri::{
    webview::{PermissionKind, PermissionResponse},
    Webview,
};

/// Media capture (microphone, camera, screen share) is requested only after the user presses a voice Join or Share action.
/// Keep that consent scoped to the packaged app's own webview origin; Linux
/// WebKitGTK otherwise defaults new media permission requests to Deny.
pub(super) fn handle(webview: Webview, kind: PermissionKind) -> PermissionResponse {
    let Ok(url) = webview.url() else {
        return PermissionResponse::Deny;
    };
    response_for(&url, kind)
}

fn response_for(url: &tauri::Url, kind: PermissionKind) -> PermissionResponse {
    if is_app_origin(url) && matches!(
            kind,
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture
        ) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

fn is_app_origin(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let packaged_origin =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();
    let dev_origin = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);

    packaged_origin || dev_origin
}

#[cfg(test)]
mod tests {
    use super::{is_app_origin, response_for};
    use tauri::{
        webview::{PermissionKind, PermissionResponse},
        Url,
    };

    #[test]
    fn permits_only_packaged_origins_and_the_local_debug_server() {
        for allowed in ["tauri://localhost/", "http://localhost:1420/"] {
            assert!(is_app_origin(&Url::parse(allowed).unwrap()), "{allowed}");
        }

        for denied in [
            "https://chat.example.com/",
            "http://tauri.localhost/",
            "http://localhost:1421/",
            "http://tauri.localhost.evil.test/",
            "http://user@tauri.localhost/",
            "http://tauri.localhost:8080/",
        ] {
            assert!(!is_app_origin(&Url::parse(denied).unwrap()), "{denied}");
        }
    }

    #[test]
    fn grants_only_capture_kinds_for_the_app_origin() {
        let app = Url::parse("tauri://localhost/").unwrap();
        assert_eq!(
            response_for(&app, PermissionKind::Microphone),
            PermissionResponse::Allow
        );
        assert_eq!(
            response_for(&app, PermissionKind::Camera),
            PermissionResponse::Allow
        );
        assert_eq!(
            response_for(&app, PermissionKind::Notifications),
            PermissionResponse::Deny
        );
        assert_eq!(
            response_for(&app, PermissionKind::DisplayCapture),
            PermissionResponse::Allow
        );

        let remote = Url::parse("https://chat.example.com/").unwrap();
        assert_eq!(
            response_for(&remote, PermissionKind::Microphone),
            PermissionResponse::Deny
        );
        assert_eq!(
            response_for(&remote, PermissionKind::Camera),
            PermissionResponse::Deny
        );
        assert_eq!(
            response_for(&remote, PermissionKind::DisplayCapture),
            PermissionResponse::Deny
        );
    }
}
