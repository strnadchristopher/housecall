//! In-house room SFU using str0m for WebRTC protocol handling, never media transcoding.
//! Authentication and membership are supplied by the embedding application.
mod peer;
use peer::{Client, Propagated};
use serde::Serialize;
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc,
    },
    time::{Duration, Instant},
};
pub use str0m::change::SdpOffer;
use str0m::{
    change::SdpAnswer,
    net::{Protocol, Receive},
    Candidate, Input, Rtc,
};
use tokio::sync::oneshot;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("voice session unauthorized")]
    Forbidden,
    #[error("invalid voice offer")]
    Invalid,
    #[error("voice capacity reached or worker unavailable")]
    Busy,
    #[error("voice I/O failed")]
    Io,
}
pub type Result<T> = std::result::Result<T, Error>;
/// Called on join and at least once a second for active media, including revoked sessions.
pub type Authorize = Arc<dyn Fn(&str, &str, &str) -> bool + Send + Sync>;
#[derive(Serialize)]
pub struct Joined {
    pub peer_id: u64,
    pub answer: SdpAnswer,
}
#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub peer_id: u64,
    pub user_id: String,
    pub connected: bool,
    /// Trusted application capture source; never an interactive member.
    pub publisher: bool,
    /// Whether this peer belongs to the authenticated session requesting this snapshot.
    pub current_session: bool,
    pub received_frames: u64,
    pub forwarded_frames: u64,
    pub forwarded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<PeerDiagnostics>,
    /// Included once per room snapshot, never used for admission or active peer counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_disconnects: Option<Vec<DisconnectedPeer>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker: Option<WorkerDiagnostics>,
}
#[derive(Debug, Clone, Serialize)]
pub struct PeerDiagnostics {
    pub ice_state: &'static str,
    pub received_datagrams: u64,
    pub transmitted_datagrams: u64,
    pub forwarding_not_ready: u64,
    pub forwarding_codec_mismatch: u64,
    pub incoming_tracks: usize,
    pub outgoing_open: usize,
    pub outgoing_waiting: usize,
    pub outgoing_negotiating: usize,
    pub pending_offer_ms: Option<u64>,
    pub output_maintenance_us: u64,
    pub output_protocol_us: u64,
    pub output_calls: u64,
    pub signaling_queued_bytes: usize,
    pub signaling_backpressure: u64,
    pub signaling_sent: u64,
    pub last_signal_in_bytes: usize,
    pub last_signal_out_bytes: usize,
    pub last_signal_in_m_lines: usize,
    pub last_signal_out_m_lines: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct DisconnectedPeer {
    pub peer_id: u64,
    pub reason: &'static str,
    pub age_ms: u64,
    pub diagnostics: PeerDiagnostics,
}
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkerDiagnostics {
    /// Includes socket wait (at most10ms normally), useful for identifying scheduling stalls.
    pub max_iteration_us: u64,
    pub max_output_batch: usize,
    pub max_receive_batch: usize,
    pub ingress_dropped: u64,
    pub max_ingress_age_us: u64,
    pub max_propagation_batch: usize,
    pub iterations: u64,
    pub control_us: u64,
    pub output_us: u64,
    pub propagation_us: u64,
    pub receive_us: u64,
    pub timers_us: u64,
}
struct ClosedPeer {
    room: String,
    at: Instant,
    snapshot: DisconnectedPeer,
}
fn remember_closed(history: &mut VecDeque<ClosedPeer>, client: &Client, now: Instant) {
    history.push_back(ClosedPeer {
        room: client.room.clone(),
        at: now,
        snapshot: DisconnectedPeer {
            peer_id: client.id.0,
            reason: client.disconnect_reason.unwrap_or("transport_closed"),
            age_ms: 0,
            diagnostics: client.diagnostics(now),
        },
    });
    while history.len() > 120 {
        history.pop_front();
    }
}
fn room_history(history: &VecDeque<ClosedPeer>, room: &str, now: Instant) -> Vec<DisconnectedPeer> {
    history
        .iter()
        .rev()
        .filter(|h| h.room == room && now.saturating_duration_since(h.at) < Duration::from_secs(60))
        .take(30)
        .map(|h| {
            let mut result = h.snapshot.clone();
            result.age_ms = now.saturating_duration_since(h.at).as_millis() as u64;
            result
        })
        .collect()
}
#[derive(Clone)]
pub struct Sfu {
    tx: SyncSender<Control>,
    address: SocketAddr,
}
enum Control {
    Join {
        room: String,
        user: String,
        session: String,
        offer: SdpOffer,
        publisher: bool,
        reply: oneshot::Sender<Result<Joined>>,
    },
    Leave {
        room: String,
        session: String,
        peer: u64,
        reply: oneshot::Sender<Result<()>>,
    },
    Stats {
        room: String,
        session: String,
        reply: oneshot::Sender<Result<Vec<Stats>>>,
    },
}
impl Sfu {
    pub fn start(bind: SocketAddr, public_ip: IpAddr, authorize: Authorize) -> Result<Self> {
        static CRYPTO: std::sync::Once = std::sync::Once::new();
        CRYPTO.call_once(|| {
            str0m::crypto::from_feature_flags().install_process_default();
        });
        let socket = UdpSocket::bind(bind).map_err(|_| Error::Io)?;
        let address = SocketAddr::new(
            public_ip,
            socket.local_addr().map_err(|_| Error::Io)?.port(),
        );
        let ingress = Ingress::start(socket.try_clone().map_err(|_| Error::Io)?)?;
        let (tx, rx) = mpsc::sync_channel(128);
        std::thread::Builder::new()
            .name("housecall-sfu".into())
            .spawn(move || run(socket, ingress, address, rx, authorize))
            .map_err(|_| Error::Io)?;
        Ok(Self { tx, address })
    }
    pub fn address(&self) -> SocketAddr {
        self.address
    }
    pub async fn join(
        &self,
        room: String,
        user: String,
        session: String,
        offer: SdpOffer,
    ) -> Result<Joined> {
        self.join_role(room, user, session, offer, false).await
    }
    /// Embedding application only: the normal HTTP join handler never selects this role.
    /// One capture source may coexist with thirty people and receives no room media.
    pub async fn join_publisher(
        &self,
        room: String,
        user: String,
        session: String,
        offer: SdpOffer,
    ) -> Result<Joined> {
        self.join_role(room, user, session, offer, true).await
    }
    async fn join_role(
        &self,
        room: String,
        user: String,
        session: String,
        offer: SdpOffer,
        publisher: bool,
    ) -> Result<Joined> {
        validate_offer(&offer)?;
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Control::Join {
                room,
                user,
                session,
                offer,
                publisher,
                reply,
            })
            .map_err(|_| Error::Busy)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| Error::Busy)?
            .map_err(|_| Error::Busy)?
    }
    pub async fn leave(&self, room: String, session: String, peer: u64) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Control::Leave {
                room,
                session,
                peer,
                reply,
            })
            .map_err(|_| Error::Busy)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| Error::Busy)?
            .map_err(|_| Error::Busy)?
    }
    pub async fn stats(&self, room: String, session: String) -> Result<Vec<Stats>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Control::Stats {
                room,
                session,
                reply,
            })
            .map_err(|_| Error::Busy)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| Error::Busy)?
            .map_err(|_| Error::Busy)?
    }
}
pub fn validate_offer(offer: &SdpOffer) -> Result<()> {
    let value = serde_json::to_value(offer).map_err(|_| Error::Invalid)?;
    let sdp = value["sdp"].as_str().ok_or(Error::Invalid)?;
    if sdp.len() > 64 * 1024
        || sdp
            .lines()
            .filter(|l| l.starts_with("m=audio") || l.starts_with("m=video"))
            .count()
            > 3
        || sdp
            .lines()
            .filter(|l| l.starts_with("m=application"))
            .count()
            != 1
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
// A slow output/SDP round must not prevent draining the kernel receive socket.
// At most1024 UDP datagrams are retained (<=64MiB even for maximal hostile packets).
// Queue overflow drops and processing age remain visible in room diagnostics.
struct Datagram {
    bytes: Vec<u8>,
    source: SocketAddr,
    received_at: Instant,
}
struct Ingress {
    packets: mpsc::Receiver<Datagram>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Ingress {
    fn start(socket: UdpSocket) -> Result<Self> {
        socket
            .set_read_timeout(Some(Duration::from_millis(10)))
            .map_err(|_| Error::Io)?;
        let (tx, packets) = mpsc::sync_channel(1024);
        let stop = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let stopping = stop.clone();
        let drops = dropped.clone();
        let thread = std::thread::Builder::new()
            .name("housecall-udp".into())
            .spawn(move || {
                let mut buffer = [0u8; 65536];
                while !stopping.load(Ordering::Relaxed) {
                    match socket.recv_from(&mut buffer) {
                        Ok((n, source)) => {
                            let packet = Datagram {
                                bytes: buffer[..n].to_vec(),
                                source,
                                received_at: Instant::now(),
                            };
                            match tx.try_send(packet) {
                                Ok(()) => {}
                                Err(mpsc::TrySendError::Full(_)) => {
                                    drops.fetch_add(1, Ordering::Relaxed);
                                }
                                Err(mpsc::TrySendError::Disconnected(_)) => break,
                            }
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| Error::Io)?;
        Ok(Self {
            packets,
            stop,
            dropped,
            thread: Some(thread),
        })
    }
}
impl Drop for Ingress {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn run(
    socket: UdpSocket,
    ingress: Ingress,
    address: SocketAddr,
    rx: mpsc::Receiver<Control>,
    authorize: Authorize,
) {
    let mut clients: Vec<Client> = Vec::new();
    let mut queued: VecDeque<Propagated> = VecDeque::new();
    let mut auth_at = Instant::now();
    let mut history = VecDeque::new();
    let mut worker = WorkerDiagnostics::default();
    loop {
        let iteration_at = Instant::now();
        worker.ingress_dropped = ingress.dropped.load(Ordering::Relaxed);
        while history.front().is_some_and(|h: &ClosedPeer| {
            iteration_at.saturating_duration_since(h.at) >= Duration::from_secs(60)
        }) {
            history.pop_front();
        }
        if auth_at.elapsed() >= Duration::from_secs(1) {
            clients.retain(|c| authorize(&c.room, &c.user, &c.session));
            auth_at = Instant::now();
        }
        clients.retain(|c| {
            if c.rtc.is_alive() {
                true
            } else {
                remember_closed(&mut history, c, iteration_at);
                false
            }
        });
        for _ in 0..32 {
            match rx.try_recv() {
                Ok(Control::Join {
                    room,
                    user,
                    session,
                    offer,
                    publisher,
                    reply,
                }) => {
                    if reply.is_closed() {
                        continue;
                    }
                    if !authorize(&room, &user, &session) {
                        let _ = reply.send(Err(Error::Forbidden));
                        continue;
                    }
                    let capacity = if publisher { 1 } else { 30 };
                    if clients
                        .iter()
                        .filter(|c| c.publisher == publisher && c.session != session)
                        .count()
                        >= capacity
                    {
                        let _ = reply.send(Err(Error::Busy));
                        continue;
                    }
                    // One connection per device in one voice channel; reconnect revokes old transport.
                    clients.retain(|c| c.session != session);
                    let mut rtc = Rtc::builder()
                        .set_sctp_max_message_size(peer::SIGNAL_MAX_BYTES as u32)
                        .set_sctp_max_buffered_amount(peer::SIGNAL_MAX_BYTES * 2)
                        .set_reordering_size_audio(3)
                        .set_reordering_timeout_audio(Some(Duration::from_millis(60)))
                        .set_stats_interval(Some(Duration::from_secs(1)))
                        .build(Instant::now());
                    let Ok(candidate) = Candidate::host(address, "udp") else {
                        let _ = reply.send(Err(Error::Invalid));
                        continue;
                    };
                    if rtc.add_local_candidate(candidate).is_none() {
                        let _ = reply.send(Err(Error::Invalid));
                        continue;
                    }
                    let Ok(answer) = rtc.sdp_api().accept_offer(offer) else {
                        let _ = reply.send(Err(Error::Invalid));
                        continue;
                    };
                    let mut client = Client::new(rtc, room, user, session);
                    client.publisher = publisher;
                    peer::introduce(&mut client, &clients);
                    let peer_id = client.id.0;
                    clients.push(client);
                    let _ = reply.send(Ok(Joined { peer_id, answer }));
                }
                Ok(Control::Leave {
                    room,
                    session,
                    peer,
                    reply,
                }) => {
                    let permitted = clients
                        .iter()
                        .any(|c| c.id.0 == peer && c.room == room && c.session == session);
                    if permitted {
                        clients.retain(|c| c.id.0 != peer);
                    }
                    let _ = reply.send(if permitted {
                        Ok(())
                    } else {
                        Err(Error::Forbidden)
                    });
                }
                Ok(Control::Stats {
                    room,
                    session,
                    reply,
                }) => {
                    if !clients.iter().any(|c| {
                        c.room == room
                            && c.session == session
                            && authorize(&c.room, &c.user, &c.session)
                    }) {
                        let _ = reply.send(Err(Error::Forbidden));
                        continue;
                    }
                    let snapshot_at = Instant::now();
                    let mut stats: Vec<Stats> = clients
                        .iter()
                        .filter(|c| c.room == room)
                        .map(|c| Stats {
                            peer_id: c.id.0,
                            user_id: c.user.clone(),
                            connected: c.connected,
                            publisher: c.publisher,
                            current_session: c.session == session,
                            received_frames: c.received_frames,
                            forwarded_frames: c.forwarded_frames,
                            forwarded_bytes: c.forwarded_bytes,
                            diagnostics: Some(c.diagnostics(snapshot_at)),
                            recent_disconnects: None,
                            worker: None,
                        })
                        .collect();
                    if let Some(first) = stats.first_mut() {
                        first.recent_disconnects = Some(room_history(&history, &room, snapshot_at));
                        first.worker = Some(worker.clone());
                    }
                    let _ = reply.send(Ok(stats));
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }
        worker.control_us += iteration_at.elapsed().as_micros() as u64;
        let output_at = Instant::now();
        let mut deadline = Instant::now() + Duration::from_millis(10);
        for client in &mut clients {
            let mut outputs = 0;
            for _ in 0..64 {
                outputs += 1;
                if !client.rtc.is_alive() {
                    break;
                }
                match client.poll_output(&socket) {
                    Propagated::Timeout(at) => {
                        deadline = deadline.min(at);
                        break;
                    }
                    Propagated::Noop => {}
                    event => queued.push_back(event),
                }
            }
            worker.max_output_batch = worker.max_output_batch.max(outputs);
        }
        worker.output_us += output_at.elapsed().as_micros() as u64;
        let propagation_at = Instant::now();
        worker.max_propagation_batch = worker.max_propagation_batch.max(queued.len());
        while let Some(event) = queued.pop_front() {
            peer::propagate(&event, &mut clients);
        }
        worker.propagation_us += propagation_at.elapsed().as_micros() as u64;
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .clamp(Duration::from_millis(1), Duration::from_millis(10));
        let mut received = 0;
        let batch_at = Instant::now();
        for index in 0..64 {
            let packet = if index == 0 {
                match ingress.packets.recv_timeout(timeout) {
                    Ok(packet) => packet,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match ingress.packets.try_recv() {
                    Ok(packet) => packet,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            };
            received += 1;
            let at = Instant::now();
            worker.max_ingress_age_us = worker
                .max_ingress_age_us
                .max(at.duration_since(packet.received_at).as_micros() as u64);
            if let Ok(contents) = packet.bytes.as_slice().try_into() {
                let input = Input::Receive(
                    at,
                    Receive {
                        proto: Protocol::Udp,
                        source: packet.source,
                        destination: address,
                        contents,
                    },
                );
                if let Some(client) = clients.iter_mut().find(|c| c.accepts(&input)) {
                    client.handle_input(input);
                }
            }
            worker.receive_us += at.elapsed().as_micros() as u64;
            if batch_at.elapsed() >= Duration::from_millis(1) {
                break;
            }
        }
        worker.max_receive_batch = worker.max_receive_batch.max(received);
        let now = Instant::now();
        for client in &mut clients {
            client.handle_input(Input::Timeout(now));
        }
        worker.timers_us += now.elapsed().as_micros() as u64;
        worker.iterations += 1;
        worker.max_iteration_us = worker
            .max_iteration_us
            .max(iteration_at.elapsed().as_micros() as u64);
    }
}
#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn ingress_is_bounded_counts_overflow_and_stops_without_a_packet() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let address = socket.local_addr().unwrap();
        let ingress = Ingress::start(socket).unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while ingress.dropped.load(Ordering::Relaxed) == 0 && Instant::now() < until {
            for _ in 0..32 {
                sender.send_to(&[7; 100], address).unwrap();
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(ingress.dropped.load(Ordering::Relaxed) > 0);
        let stopped = Instant::now();
        drop(ingress);
        assert!(stopped.elapsed() < Duration::from_secs(1));
        let idle = Ingress::start(UdpSocket::bind("127.0.0.1:0").unwrap()).unwrap();
        drop(idle);
    }
    #[test]
    fn disconnect_history_is_bounded_expires_and_is_room_scoped() {
        str0m::crypto::from_feature_flags().install_process_default();
        let now = Instant::now();
        let mut history = VecDeque::new();
        for n in 0..130 {
            let client = Client::new(
                Rtc::new(now),
                if n % 2 == 0 { "a" } else { "b" }.into(),
                "user".into(),
                "secret-session".into(),
            );
            remember_closed(&mut history, &client, now);
        }
        assert_eq!(history.len(), 120);
        let visible = room_history(&history, "a", now);
        assert_eq!(visible.len(), 30);
        assert!(visible.iter().all(|item| history
            .iter()
            .any(|h| h.room == "a" && h.snapshot.peer_id == item.peer_id)));
        assert!(room_history(&history, "absent", now).is_empty());
        assert!(room_history(&history, "a", now + Duration::from_secs(60)).is_empty());
        let public = serde_json::to_string(&visible).unwrap();
        assert!(!public.contains("secret-session"));
        assert!(!public.contains("sdp"));
    }
}
