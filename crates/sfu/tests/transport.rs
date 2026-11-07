//! Real localhost UDP ICE/DTLS/SRTP roundtrip with synthetic encoded Opus frames.
//! This is not a browser decode test or glass-to-glass measurement.
use chriscord_sfu::{SdpOffer, Sfu};
use std::{
    net::UdpSocket,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use str0m::{
    media::{Direction, MediaKind, Mid},
    net::{Protocol, Receive},
    Candidate, Event, Input, Output, Rtc,
};

struct Peer {
    rtc: Rtc,
    socket: UdpSocket,
    mid: Mid,
    received: usize,
    value: u8,
    sent_at: Instant,
}
impl Peer {
    async fn connect(sfu: &Sfu, room: &str, user: &str, value: u8) -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        let mut rtc = Rtc::new(Instant::now());
        rtc.add_local_candidate(Candidate::host(socket.local_addr().unwrap(), "udp").unwrap())
            .unwrap();
        let mut change = rtc.sdp_api();
        change.add_channel("chriscord-signaling".into());
        let mid = change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();
        let joined = sfu
            .join(room.into(), user.into(), user.into(), offer)
            .await
            .unwrap();
        rtc.sdp_api().accept_answer(pending, joined.answer).unwrap();
        Self {
            rtc,
            socket,
            mid,
            received: 0,
            value,
            sent_at: Instant::now(),
        }
    }
    fn step(&mut self, start: Instant) {
        let now = Instant::now();
        self.rtc.handle_input(Input::Timeout(now)).unwrap();
        if self.sent_at.elapsed() >= Duration::from_millis(20) {
            if let Some(writer) = self.rtc.writer(self.mid) {
                let pt = writer
                    .payload_params()
                    .find(|p| p.spec().codec == str0m::format::Codec::Opus)
                    .map(|p| p.pt());
                if let Some(pt) = pt {
                    writer
                        .write(
                            pt,
                            now,
                            now.duration_since(start).into(),
                            vec![self.value; 80],
                        )
                        .unwrap();
                }
            }
            self.sent_at = now;
        }
        for _ in 0..256 {
            match self.rtc.poll_output().unwrap() {
                Output::Timeout(_) => break,
                Output::Transmit(t) => {
                    self.socket.send_to(&t.contents, t.destination).unwrap();
                }
                Output::Event(Event::ChannelData(d)) => {
                    let offer: SdpOffer = serde_json::from_slice(&d.data).unwrap();
                    let answer = self.rtc.sdp_api().accept_offer(offer).unwrap();
                    self.rtc
                        .channel(d.id)
                        .unwrap()
                        .write(false, &serde_json::to_vec(&answer).unwrap())
                        .unwrap();
                }
                Output::Event(Event::MediaData(d)) => {
                    assert_ne!(d.data[0], self.value, "must never echo own encoded stream");
                    self.received += 1;
                }
                _ => {}
            }
        }
        let mut buf = [0; 65536];
        while let Ok((n, source)) = self.socket.recv_from(&mut buf) {
            let input = Input::Receive(
                Instant::now(),
                Receive {
                    proto: Protocol::Udp,
                    source,
                    destination: self.socket.local_addr().unwrap(),
                    contents: (&buf[..n]).try_into().unwrap(),
                },
            );
            if self.rtc.accepts(&input) {
                self.rtc.handle_input(input).unwrap();
            }
        }
    }
}
#[tokio::test]
async fn three_peers_forward_encrypted_udp_media_room_isolation_and_revocation() {
    let revoked = Arc::new(AtomicBool::new(false));
    let policy = revoked.clone();
    let sfu = Sfu::start(
        "127.0.0.1:0".parse().unwrap(),
        "127.0.0.1".parse().unwrap(),
        Arc::new(move |_, user, _| !(user == "alice" && policy.load(Ordering::SeqCst))),
    )
    .unwrap();
    let mut peers = Vec::new();
    for (room, user, value) in [
        ("room", "alice", 1),
        ("room", "bob", 2),
        ("room", "cara", 3),
        ("other", "outsider", 4),
    ] {
        peers.push(Peer::connect(&sfu, room, user, value).await);
    }
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(8) {
        for peer in &mut peers {
            peer.step(start);
        }
        if peers[..3].iter().all(|p| p.received >= 50) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    for (i, peer) in peers[..3].iter().enumerate() {
        assert!(
            peer.received >= 50,
            "peer {i} received only {} encoded frames",
            peer.received
        );
    }
    assert_eq!(peers[3].received, 0, "cross-room stream leaked");
    let stats = sfu.stats("room".into(), "bob".into()).await.unwrap();
    assert_eq!(stats.len(), 3);
    assert!(stats
        .iter()
        .all(|s| s.connected && s.received_frames > 0 && s.forwarded_frames > 0));
    println!(
        "real UDP SFU counters: {}",
        serde_json::to_string(&stats).unwrap()
    );
    revoked.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(sfu.stats("room".into(), "alice".into()).await.is_err());
    let remaining = sfu.stats("room".into(), "bob".into()).await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert!(sfu
        .leave(
            "room".into(),
            "bob".into(),
            remaining
                .iter()
                .find(|s| s.user_id == "cara")
                .unwrap()
                .peer_id
        )
        .await
        .is_err());
}
proptest::proptest! {
    #[test]
    fn sdp_json_parser_never_panics(data in ".{0,8192}") { let _ = serde_json::from_str::<SdpOffer>(&data); }
}
