use housecall_activities::{session::Track, Command, Error, Kind, Session};
use std::collections::BTreeSet;
fn members() -> BTreeSet<String> {
    ["alice", "bob", "cara"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}
fn room(kind: Kind) -> Session {
    Session::new(kind, "alice".into(), members(), 1000).unwrap()
}
fn track(id: &str) -> Track {
    Track {
        id: id.into(),
        title: "A song".into(),
        source: "https://youtu.be/dQw4w9WgXcQ".into(),
        duration_ms: 2000,
        requested_by: "forged".into(),
    }
}
#[test]
fn three_client_watch_party_sync_pause_seek_and_reconnect() {
    let mut s = room(Kind::Plex);
    s.apply(
        "alice",
        0,
        Command::Select {
            media_id: "42".into(),
            duration_ms: 100_000,
        },
        1000,
    )
    .unwrap();
    s.apply("alice", 1, Command::Play {}, 1100).unwrap();
    let snapshots: Vec<_> = ["alice", "bob", "cara"]
        .iter()
        .map(|u| s.snapshot(u, 5100).unwrap())
        .collect();
    assert!(snapshots.windows(2).all(|w| w[0] == w[1]));
    assert_eq!(snapshots[0].playback.position_ms, 4000);
    s.apply("alice", 2, Command::Pause {}, 5100).unwrap();
    assert_eq!(s.snapshot("cara", 9900).unwrap().playback.position_ms, 4000);
    s.apply(
        "alice",
        3,
        Command::Seek {
            position_ms: 50_000,
        },
        9900,
    )
    .unwrap();
    let restored: Session = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(
        restored.snapshot("bob", 10_000).unwrap(),
        s.snapshot("cara", 10_000).unwrap()
    );
    assert_eq!(
        restored
            .snapshot("bob", 10_000)
            .unwrap()
            .playback
            .position_ms,
        50_000
    );
}
#[test]
fn membership_revision_and_host_permissions_are_transactional() {
    let mut s = room(Kind::Plex);
    let before = serde_json::to_string(&s).unwrap();
    assert!(matches!(
        s.apply("mallory", 0, Command::Play {}, 1000),
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        s.apply(
            "bob",
            0,
            Command::Select {
                media_id: "42".into(),
                duration_ms: 20
            },
            1000
        ),
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        s.apply("alice", 9, Command::Play {}, 1000),
        Err(Error::Conflict)
    ));
    assert!(s.snapshot("mallory", 1000).is_err());
    assert_eq!(before, serde_json::to_string(&s).unwrap());
}
#[test]
fn dj_queue_majority_vote_deduplication_ownership_and_timer() {
    let mut s = room(Kind::Dj);
    let first = s
        .apply(
            "bob",
            0,
            Command::Enqueue {
                track: track("one"),
            },
            1000,
        )
        .unwrap();
    assert_eq!(first.queue[0].requested_by, "bob");
    s.apply(
        "cara",
        1,
        Command::Enqueue {
            track: track("two"),
        },
        1000,
    )
    .unwrap();
    s.apply("bob", 2, Command::VoteSkip {}, 1001).unwrap();
    s.apply("bob", 3, Command::VoteSkip {}, 1002).unwrap();
    assert_eq!(s.snapshot("bob", 1002).unwrap().queue.len(), 2);
    let next = s.apply("cara", 4, Command::VoteSkip {}, 1003).unwrap();
    assert_eq!(next.playback.media_id.as_deref(), Some("two"));
    assert!(next.skip_votes.is_empty());
    assert!(matches!(
        s.apply(
            "bob",
            5,
            Command::Remove {
                track_id: "two".into()
            },
            1003
        ),
        Err(Error::Forbidden)
    ));
    assert!(s.tick(3002).is_none());
    let end = s.tick(3003).unwrap();
    assert!(end.queue.is_empty());
    assert!(!end.playback.playing);
}
#[test]
fn vm_control_lease_handoff_expiry_revocation() {
    let mut s = room(Kind::Vm);
    s.apply("alice", 0, Command::RequestControl {}, 1000)
        .unwrap();
    s.apply("bob", 1, Command::RequestControl {}, 1100).unwrap();
    assert!(s.authorize_input("bob", 1100).is_err());
    assert!(s.authorize_input("alice", 1100).is_ok());
    assert!(s
        .apply(
            "bob",
            2,
            Command::Handoff {
                user_id: "cara".into()
            },
            1100
        )
        .is_err());
    s.apply(
        "alice",
        2,
        Command::Handoff {
            user_id: "bob".into(),
        },
        1200,
    )
    .unwrap();
    assert!(s.authorize_input("alice", 1200).is_err());
    assert!(s.authorize_input("bob", 31_199).is_ok());
    assert!(s.authorize_input("bob", 31_200).is_err());
    assert!(s.snapshot("cara", 31_200).unwrap().controller.is_none());
    s.apply("cara", 3, Command::RequestControl {}, 31_200)
        .unwrap();
    let mut m = members();
    m.remove("cara");
    s.replace_members(m, 31_201).unwrap();
    assert!(s.authorize_input("cara", 31_201).is_err());
    assert!(s.snapshot("bob", 31_201).unwrap().controller.is_none());
}
#[test]
fn departing_host_transfers_and_commands_cannot_cross_activity_kinds() {
    let mut s = room(Kind::Plex);
    let mut m = members();
    m.remove("alice");
    s.replace_members(m, 1001).unwrap();
    assert_eq!(s.snapshot("bob", 1001).unwrap().host, "bob");
    assert!(s.apply("alice", 1, Command::Play {}, 1001).is_err());
    assert!(s.apply("bob", 1, Command::RequestControl {}, 1001).is_err());
    assert!(s
        .apply("bob", 1, Command::Enqueue { track: track("x") }, 1001)
        .is_err());
}
#[test]
fn malformed_protocol_fields_are_rejected() {
    assert!(serde_json::from_str::<Command>(r#"{"type":"play","admin":true}"#).is_err());
    assert!(serde_json::from_str::<Command>(r#"{"type":"seek","position_ms":-1}"#).is_err());
    assert!(serde_json::from_str::<Command>(r#"{"type":"handoff","user_id":null}"#).is_err());
}
proptest::proptest! {
    #[test]
    fn parser_never_panics_and_normalized_sources_roundtrip(raw in ".{0,2048}") {
        if let Ok(s) = housecall_activities::dj::Source::parse(&raw) {
            proptest::prop_assert_eq!(housecall_activities::dj::Source::parse(&s.normalized()).unwrap(), s);
        }
    }
    #[test]
    fn protocol_parser_never_panics(raw in ".{0,4096}") {
        let _ = serde_json::from_str::<Command>(&raw);
    }
    #[test]
    fn playback_position_is_bounded(now in 0u64..u64::MAX, position in 0u64..u64::MAX, duration in 0u64..u64::MAX) {
        let p = housecall_activities::session::Playback { media_id: None, playing: true, position_ms: position, anchored_at_ms: 0, duration_ms: duration };
        proptest::prop_assert!(p.position_at(now) <= duration);
    }
}
#[test]
fn rejects_ssrf_url_and_cli_injection_sources() {
    for raw in [
        "http://youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
        "https://127.0.0.1/secret",
        "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
        "file:///etc/passwd",
        "--exec=whoami",
        "ytsearch:bad",
        "https://soundcloud.com/a/../../secrets",
        "https://youtu.be/dQw4w9WgXcQ/extra",
    ] {
        assert!(
            housecall_activities::dj::Source::parse(raw).is_err(),
            "accepted {raw}"
        );
    }
}
