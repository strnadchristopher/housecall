use housecall_activities::plex::Plex;
use proptest::prelude::*;
use url::Url;
fn plex() -> Plex {
    Plex::new("http://127.0.0.1:32400", "fixture-private-token".into()).unwrap()
}
fn base() -> Url {
    Url::parse("http://127.0.0.1:32400/video/:/transcode/universal/start.m3u8").unwrap()
}
#[test]
fn all_hls_uri_forms_are_local_and_credentials_stay_server_side() {
    let text="#EXTM3U\n#provider http://secret.invalid\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English, CC\",URI=\"session/subs.m3u8?X-Plex-Token=secret\"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI=\"session/iframe.m3u8\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"session/key\"\n#EXT-X-MAP:URI=\"session/init.mp4\",BYTERANGE=\"500@0\"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS=\"avc1.42e01e,mp4a.40.2\"\nsession/nested.m3u8\n#EXTINF:6.0,\nsession/segment.ts\n";
    let mut resources = Vec::new();
    let output = plex()
        .rewrite_manifest(text, &base(), |r| {
            resources.push(r);
            Ok(format!(
                "/api/channels/c/plex/resources/{}",
                resources.len()
            ))
        })
        .unwrap();
    assert_eq!(resources.len(), 6);
    assert!(resources[0].playlist);
    assert!(resources[1].playlist);
    assert!(!resources[2].playlist);
    assert!(resources[4].playlist);
    assert!(!resources[5].playlist);
    assert!(!output.contains("secret"));
    assert!(!output.contains("session/"));
    assert!(!output.contains("http"));
    assert!(!resources[0].url.as_str().contains("Token"));
    assert!(output.contains("CODECS=\"avc1.42e01e,mp4a.40.2\""));
}
#[test]
fn origin_path_redirect_style_and_attribute_ssrf_rejected() {
    for uri in [
        "https://evil.invalid/file",
        "//evil.invalid/file",
        "http://127.0.0.1:80/file",
        "http://user@127.0.0.1:32400/video/:/transcode/a",
        "file:///etc/passwd",
        "data:abc",
        "/:/prefs",
        "/video/:/transcode/universal/stop?session=stolen",
        "/video/:/transcode/%2f..%2fadmin",
        "/video/:/transcode/a#token",
        "../../../identity",
    ] {
        assert!(plex().resource(&base(), uri, false).is_err(), "{uri}");
        assert!(
            plex()
                .rewrite_manifest(
                    &format!("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"{uri}\"\n"),
                    &base(),
                    |_| Ok("/api/local".into())
                )
                .is_err(),
            "{uri}"
        );
    }
    assert!(plex()
        .rewrite_manifest(
            "#EXTM3U\n/video/:/transcode/universal/start.m3u8?session=other\n",
            &base(),
            |_| Ok("/api/local".into())
        )
        .is_err());
    for malformed in [
        "#EXTM3U\n#EXT-X-MAP:URI=bad\n",
        "#EXTM3U\n#EXT-X-MAP:URI=\"unclosed\n",
        "#EXTM3U\n#EXT-X-SESSION-DATA:VALUE=\"http://private/\"\n",
        "#EXTM3U\n#EXTINF:5,fixture-private-token\na.ts\n",
    ] {
        assert!(plex()
            .rewrite_manifest(malformed, &base(), |_| Ok("/api/local".into()))
            .is_err());
    }
}
proptest! {
 #[test]
 fn arbitrary_manifest_input_never_panics(text in ".{0,8192}") {
  let _=plex().rewrite_manifest(&text,&base(), |_|Ok("/api/local".into()));
 }
}

#[tokio::test]
async fn resource_fixture_preserves_range_strips_query_token_and_refuses_redirect() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let worker = std::thread::spawn(move || {
        for (status, headers, body) in [
            (
                "206 Partial Content",
                "Content-Type: video/mp2t\r\nContent-Range: bytes 0-2/10\r\n",
                "abc",
            ),
            (
                "302 Found",
                "Location: http://169.254.169.254/latest/meta-data\r\n",
                "",
            ),
        ] {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut input = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                input.extend_from_slice(&buffer[..n]);
                if n == 0 || input.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            seen.lock().unwrap().push(String::from_utf8(input).unwrap());
            write!(socket,"HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    let plex = Plex::new(&origin, "fixture-private-token".into()).unwrap();
    let base = Url::parse(&format!(
        "{origin}/video/:/transcode/universal/session/index.m3u8"
    ))
    .unwrap();
    let resource = plex
        .resource(&base, "segment.ts?X-Plex-Token=attacker-token", false)
        .unwrap();
    let response = plex.fetch(&resource, Some("bytes=0-2")).await.unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.text().await.unwrap(), "abc");
    assert!(plex.fetch(&resource, None).await.is_err());
    worker.join().unwrap();
    for request in requests.lock().unwrap().iter() {
        assert!(request
            .to_ascii_lowercase()
            .contains("x-plex-token: fixture-private-token"));
        assert!(!request.contains("attacker-token"));
        assert!(!request
            .lines()
            .next()
            .unwrap()
            .contains("fixture-private-token"));
    }
    assert!(requests.lock().unwrap()[0]
        .to_ascii_lowercase()
        .contains("range: bytes=0-2"));
    for range in [
        "bytes=-",
        "bytes=2-1",
        "bytes=0-999999999",
        "bytes=0-1,5-6",
        "other=0-2",
    ] {
        assert!(plex.fetch(&resource, Some(range)).await.is_err());
    }
}
