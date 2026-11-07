//! In-house room SFU using str0m for WebRTC protocol handling, never media transcoding.
//! Authentication and membership are supplied by the embedding application.
mod peer;
use peer::{Client, Propagated};
use serde::Serialize;
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr, UdpSocket},
    sync::{
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
    pub received_frames: u64,
    pub forwarded_frames: u64,
    pub forwarded_bytes: u64,
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
        socket
            .set_read_timeout(Some(Duration::from_millis(10)))
            .map_err(|_| Error::Io)?;
        let (tx, rx) = mpsc::sync_channel(128);
        std::thread::Builder::new()
            .name("chriscord-sfu".into())
            .spawn(move || run(socket, address, rx, authorize))
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
        validate_offer(&offer)?;
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Control::Join {
                room,
                user,
                session,
                offer,
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
fn run(socket: UdpSocket, address: SocketAddr, rx: mpsc::Receiver<Control>, authorize: Authorize) {
    let mut clients: Vec<Client> = Vec::new();
    let mut queued: VecDeque<Propagated> = VecDeque::new();
    let mut buffer = [0u8; 65536];
    let mut auth_at = Instant::now();
    loop {
        if auth_at.elapsed() >= Duration::from_secs(1) {
            clients.retain(|c| authorize(&c.room, &c.user, &c.session));
            auth_at = Instant::now();
        }
        clients.retain(|c| c.rtc.is_alive());
        for _ in 0..32 {
            match rx.try_recv() {
                Ok(Control::Join {
                    room,
                    user,
                    session,
                    offer,
                    reply,
                }) => {
                    if reply.is_closed() {
                        continue;
                    }
                    if !authorize(&room, &user, &session) {
                        let _ = reply.send(Err(Error::Forbidden));
                        continue;
                    }
                    if clients.len() >= 30 && !clients.iter().any(|c| c.session == session) {
                        let _ = reply.send(Err(Error::Busy));
                        continue;
                    }
                    // One connection per device in one voice channel; reconnect revokes old transport.
                    clients.retain(|c| c.session != session);
                    let mut rtc = Rtc::builder()
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
                    let stats = clients
                        .iter()
                        .filter(|c| c.room == room)
                        .map(|c| Stats {
                            peer_id: c.id.0,
                            user_id: c.user.clone(),
                            connected: c.connected,
                            received_frames: c.received_frames,
                            forwarded_frames: c.forwarded_frames,
                            forwarded_bytes: c.forwarded_bytes,
                        })
                        .collect();
                    let _ = reply.send(Ok(stats));
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }
        let mut deadline = Instant::now() + Duration::from_millis(10);
        for client in &mut clients {
            for _ in 0..256 {
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
        }
        while let Some(event) = queued.pop_front() {
            peer::propagate(&event, &mut clients);
        }
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .clamp(Duration::from_millis(1), Duration::from_millis(10));
        if socket.set_read_timeout(Some(timeout)).is_err() {
            return;
        }
        match socket.recv_from(&mut buffer) {
            Ok((n, source)) => {
                if let Ok(contents) = (&buffer[..n]).try_into() {
                    let input = Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: address,
                            contents,
                        },
                    );
                    if let Some(client) = clients.iter_mut().find(|c| c.accepts(&input)) {
                        client.handle_input(input);
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
        let now = Instant::now();
        for client in &mut clients {
            client.handle_input(Input::Timeout(now));
        }
    }
}
