//! All provider network tests use local TCP fixtures, never production credentials/services.
use housecall_activities::{
    dj::Switchboard,
    gimme::{Gimme, Mode, Poll, Request, Submission},
    plex::Plex,
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
fn fixture(
    responses: Vec<serde_json::Value>,
) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let worker = std::thread::spawn(move || {
        for body in responses {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            captured
                .lock()
                .unwrap()
                .push(String::from_utf8(bytes).unwrap());
            let status = if body.get("job_id").is_some() && body["status"] == "accepted" {
                "202 Accepted"
            } else {
                "200 OK"
            };
            let encoded = serde_json::to_vec(&body).unwrap();
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", encoded.len()).unwrap();
            socket.write_all(&encoded).unwrap();
        }
    });
    (origin, seen, worker)
}
#[tokio::test]
async fn switchboard_exact_model_and_task_header_on_loopback_fixture() {
    let (origin, seen, worker) = fixture(vec![
        json!({"choices":[{"message":{"content":"Next up: a good song."}}]}),
    ]);
    let board = Switchboard::loopback(&format!("{origin}v1/chat/completions")).unwrap();
    assert_eq!(
        board.banter(Some("Previous"), "Next").await.unwrap(),
        "Next up: a good song."
    );
    worker.join().unwrap();
    let requests = seen.lock().unwrap();
    let request = &requests[0];
    assert!(request
        .to_lowercase()
        .contains("x-inference-task: housecall.dj"));
    let body: serde_json::Value =
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["model"], "role:chat");
    assert!(Switchboard::loopback("https://hosted-tts.example/v1").is_err());
}
#[tokio::test]
async fn plex_browse_token_header_and_sanitized_dtos_fixture() {
    let (origin, seen, worker) = fixture(vec![
        json!({"MediaContainer":{"Directory":[{"key":"1","title":"Movies","type":"movie"}]}}),
        json!({"MediaContainer":{"Metadata":[{"ratingKey":"42","title":"Movie","type":"movie","duration":10000,"Media":[{"Part":[{"Stream":[{"id":9,"streamType":3,"language":"English","codec":"srt","key":"/library/streams/9?secret=bad"}]}]}]}]}}),
    ]);
    let plex = Plex::new(&origin, "fixture-secret".into()).unwrap();
    assert_eq!(plex.libraries().await.unwrap()[0].id, "1");
    let items = plex.browse("1", 0).await.unwrap();
    assert_eq!(items[0].subtitles[0].id, "9");
    assert!(!serde_json::to_string(&items).unwrap().contains("secret"));
    assert!(plex.browse("../../admin", 0).await.is_err());
    worker.join().unwrap();
    for request in seen.lock().unwrap().iter() {
        assert!(request
            .to_lowercase()
            .contains("x-plex-token: fixture-secret"));
        assert!(!request.lines().next().unwrap().contains("fixture-secret"));
    }
}
#[tokio::test]
async fn gimme_dry_run_discovery_idempotency_and_no_network() {
    let mut g = Gimme::new(
        "https://gimme.invalid/",
        "never-used".into(),
        Mode::default(),
    )
    .unwrap();
    let req = Request::Movie {
        query: "Test Movie 2000".into(),
    };
    assert!(g.submit(req.clone(), "key-1").await.is_err());
    assert!(g
        .discover_fixture(&json!({"api_version":1}), &json!({"api_version":2}))
        .is_err());
    g.discover_fixture(&json!({"api_version":2}), &json!({"api_version":2}))
        .unwrap();
    let first = g.submit(req.clone(), "key-1").await.unwrap();
    assert!(matches!(first, Submission::DryRun { .. }));
    assert_eq!(first, g.submit(req, "key-1").await.unwrap());
    assert!(g
        .submit(
            Request::Tv {
                query: "Other".into()
            },
            "key-1"
        )
        .await
        .is_err());
}
#[tokio::test]
async fn gimme_async_protocol_loopback_fixture_202_is_not_completion() {
    let (origin, seen, worker) = fixture(vec![
        json!({"api_version":2}),
        json!({"api_version":2}),
        json!({"status":"accepted","job_id":"job-1","poll":"/agent/jobs/job-1","retry_after_ms":5}),
        json!({"status":"running"}),
        json!({"status":"complete","result_status":"success","result":{"status":"confirmation_required"}}),
    ]);
    let mut g = Gimme::new(&origin, "fixture-gimme".into(), Mode::Live).unwrap();
    g.discover().await.unwrap();
    let Submission::Accepted { job } = g
        .submit(
            Request::Movie {
                query: "Fixture only".into(),
            },
            "uuid-1",
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(g.poll(&job).await.unwrap(), Poll::Pending { .. }));
    let Poll::Complete { result, .. } = g.poll(&job).await.unwrap() else {
        panic!()
    };
    assert_eq!(result["status"], "confirmation_required");
    worker.join().unwrap();
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(requests[2]
        .to_lowercase()
        .contains("idempotency-key: uuid-1"));
    assert!(requests
        .iter()
        .all(|r| r.to_lowercase().contains("x-api-key: fixture-gimme")));
    assert!(requests
        .iter()
        .all(|r| !r.to_lowercase().contains("authorization:")));
}
#[test]
fn gimme_poll_url_ssrf_and_terminal_outcomes() {
    let g = Gimme::new("https://api.example.com/", "fixture".into(), Mode::DryRun).unwrap();
    for path in [
        "https://evil.test/agent/jobs/j",
        "//evil.test/agent/jobs/j",
        "/agent/jobs/../contract",
        "/agent/jobs/j?redirect=evil",
        "/agent/jobs/other",
        "/agent/jobs/%2f",
    ] {
        assert!(g
            .parse_job(&json!({"job_id":"j","poll":path}), None)
            .is_err());
    }
    let job = g
        .parse_job(
            &json!({"job_id":"j","poll":"/agent/jobs/j","retry_after_ms":50}),
            Some(5000),
        )
        .unwrap();
    assert_eq!(job.retry_after_ms, 5000);
    assert!(matches!(Gimme::interpret_poll(&job, &json!({"status":"failed","retryable":false,"code":"idempotency_conflict","error":"Conflict"}), None).unwrap(), Poll::Failed { retryable:false, .. }));
    assert!(Gimme::interpret_poll(&job, &json!({"status":"complete"}), None).is_err());
}

#[tokio::test]
async fn bounded_metadata_rejects_content_length_and_chunked_overflow() {
    for chunked in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).unwrap();
            if chunked {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n").unwrap();
            } else {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        let response = reqwest::get(endpoint).await.unwrap();
        assert!(housecall_activities::read_json(response, 8).await.is_err());
        worker.join().unwrap();
    }
}
