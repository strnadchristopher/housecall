// Derived from str0m examples/chat.rs; see ../NOTICE and ../LICENSE-STR0M-MIT.
use std::{
    net::UdpSocket,
    ops::Deref,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelData, ChannelId};
use str0m::media::{
    Direction, KeyframeRequest, KeyframeRequestKind, MediaData, MediaKind, Mid, Rid,
};
use str0m::{Event, IceConnectionState, Input, Output, Rtc};
use tracing::{info, warn};
#[derive(Debug)]
pub(crate) struct Client {
    pub room: String,
    pub user: String,
    pub session: String,
    pub connected: bool,
    pub publisher: bool,
    pub received_frames: u64,
    pub forwarded_frames: u64,
    pub forwarded_bytes: u64,
    pub id: ClientId,
    pub rtc: Rtc,
    pending: Option<SdpPendingOffer>,
    pending_since: Option<Instant>,
    signal: Option<PendingSignal>,
    pub(crate) disconnect_reason: Option<&'static str>,
    ice_state: &'static str,
    signal_backpressure: u64,
    received_datagrams: u64,
    transmitted_datagrams: u64,
    forwarding_not_ready: u64,
    forwarding_codec_mismatch: u64,
    signals_sent: u64,
    signal_in_bytes: usize,
    signal_out_bytes: usize,
    signal_in_m_lines: usize,
    signal_out_m_lines: usize,
    cid: Option<ChannelId>,
    tracks_in: Vec<TrackInEntry>,
    tracks_out: Vec<TrackOut>,
    chosen_rid: Option<Rid>,
    output_maintenance_us: u64,
    output_protocol_us: u64,
    output_calls: u64,
}

// Thirty two-track publishers require ~61 media sections in a receiver's SDP.
// Keep a finite limit while allowing the resulting offer and answer to fit.
pub(crate) const SIGNAL_MAX_BYTES: usize = 256 * 1024;
const SIGNAL_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const SIGNAL_ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
const SIGNAL_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// A single bounded payload. Ok(false) from str0m means the aggregate SCTP
/// buffer cannot currently accept the entire message; no bytes were accepted.
#[derive(Debug)]
struct PendingSignal {
    payload: Vec<u8>,
    deadline: Instant,
    retry_at: Instant,
}
#[derive(Debug, PartialEq, Eq)]
enum SignalProgress {
    Waiting,
    Backpressure,
    Sent,
}
impl PendingSignal {
    fn new(payload: Vec<u8>, now: Instant) -> Result<Self, &'static str> {
        if payload.len() > SIGNAL_MAX_BYTES {
            return Err("signaling_message_limit");
        }
        Ok(Self {
            payload,
            deadline: now + SIGNAL_SEND_TIMEOUT,
            retry_at: now,
        })
    }
    fn attempt(
        &mut self,
        now: Instant,
        send: impl FnOnce(&[u8]) -> Result<bool, ()>,
    ) -> Result<SignalProgress, &'static str> {
        if now >= self.deadline {
            return Err("signaling_send_timeout");
        }
        if now < self.retry_at {
            return Ok(SignalProgress::Waiting);
        }
        self.retry_at = now + SIGNAL_RETRY_INTERVAL;
        match send(&self.payload) {
            Ok(true) => Ok(SignalProgress::Sent),
            Ok(false) => Ok(SignalProgress::Backpressure),
            Err(()) => Err("signaling_write_error"),
        }
    }
}
fn signal_shape(data: &[u8]) -> (usize, usize) {
    let m_lines = serde_json::from_slice::<serde_json::Value>(data)
        .ok()
        .and_then(|v| {
            v["sdp"]
                .as_str()
                .map(|s| s.lines().filter(|l| l.starts_with("m=")).count())
        })
        .unwrap_or(0);
    (data.len(), m_lines)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClientId(pub u64);

impl Deref for ClientId {
    type Target = u64;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[derive(Debug)]
pub(crate) struct TrackIn {
    origin: ClientId,
    mid: Mid,
    kind: MediaKind,
    /// A publisher's second audio track: the sound of a shared screen, kept apart from the voice.
    share: bool,
}

/// The stream id a subscriber sees for a track: the publisher's id, and for share audio the same
/// id with a `-share` suffix, so the browser can tell the screen's sound from the voice.
fn stream_id(track: &TrackIn) -> String {
    if track.share {
        format!("{}-share", track.origin.0)
    } else {
        track.origin.0.to_string()
    }
}

#[derive(Debug)]
struct TrackInEntry {
    id: Arc<TrackIn>,
    last_keyframe_request: Option<Instant>,
}

#[derive(Debug)]
struct TrackOut {
    track_in: Weak<TrackIn>,
    state: TrackOutState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackOutState {
    ToOpen,
    Negotiating(Mid),
    Open(Mid),
    ToStop(Mid),
    NegotiatingStop(Mid),
}

impl TrackOut {
    fn mid(&self) -> Option<Mid> {
        match self.state {
            TrackOutState::ToOpen => None,
            TrackOutState::Negotiating(m)
            | TrackOutState::Open(m)
            | TrackOutState::ToStop(m)
            | TrackOutState::NegotiatingStop(m) => Some(m),
        }
    }
}

impl Client {
    pub(crate) fn new(rtc: Rtc, room: String, user: String, session: String) -> Client {
        static ID_COUNTER: AtomicU64 = AtomicU64::new(0);
        let next_id = ID_COUNTER.fetch_add(1, Ordering::SeqCst);
        Client {
            room,
            user,
            session,
            connected: false,
            publisher: false,
            received_frames: 0,
            forwarded_frames: 0,
            forwarded_bytes: 0,
            id: ClientId(next_id),
            rtc,
            pending: None,
            pending_since: None,
            signal: None,
            disconnect_reason: None,
            ice_state: "new",
            signal_backpressure: 0,
            received_datagrams: 0,
            transmitted_datagrams: 0,
            forwarding_not_ready: 0,
            forwarding_codec_mismatch: 0,
            signals_sent: 0,
            signal_in_bytes: 0,
            signal_out_bytes: 0,
            signal_in_m_lines: 0,
            signal_out_m_lines: 0,
            cid: None,
            tracks_in: vec![],
            tracks_out: vec![],
            chosen_rid: None,
            output_maintenance_us: 0,
            output_protocol_us: 0,
            output_calls: 0,
        }
    }

    pub(crate) fn disconnect(&mut self, reason: &'static str) {
        if self.disconnect_reason.is_none() {
            self.disconnect_reason = Some(reason);
            // Fixed code and opaque peer ID only; no SDP, ICE candidates or device/session secrets.
            warn!(peer_id = *self.id, reason, "SFU peer disconnected");
        }
        self.rtc.disconnect();
    }
    pub(crate) fn diagnostics(&self, now: Instant) -> crate::PeerDiagnostics {
        crate::PeerDiagnostics {
            ice_state: self.ice_state,
            received_datagrams: self.received_datagrams,
            transmitted_datagrams: self.transmitted_datagrams,
            forwarding_not_ready: self.forwarding_not_ready,
            forwarding_codec_mismatch: self.forwarding_codec_mismatch,
            incoming_tracks: self.tracks_in.len(),
            outgoing_open: self
                .tracks_out
                .iter()
                .filter(|t| matches!(t.state, TrackOutState::Open(_)))
                .count(),
            outgoing_waiting: self
                .tracks_out
                .iter()
                .filter(|t| matches!(t.state, TrackOutState::ToOpen))
                .count(),
            outgoing_negotiating: self
                .tracks_out
                .iter()
                .filter(|t| matches!(t.state, TrackOutState::Negotiating(_)))
                .count(),
            pending_offer_ms: self
                .pending_since
                .map(|at| now.saturating_duration_since(at).as_millis() as u64),
            output_maintenance_us: self.output_maintenance_us,
            output_protocol_us: self.output_protocol_us,
            output_calls: self.output_calls,
            signaling_queued_bytes: self.signal.as_ref().map_or(0, |s| s.payload.len()),
            signaling_backpressure: self.signal_backpressure,
            signaling_sent: self.signals_sent,
            last_signal_in_bytes: self.signal_in_bytes,
            last_signal_out_bytes: self.signal_out_bytes,
            last_signal_in_m_lines: self.signal_in_m_lines,
            last_signal_out_m_lines: self.signal_out_m_lines,
        }
    }
    fn queue_signal(&mut self, data: Vec<u8>, now: Instant) {
        if self.signal.is_some() {
            self.disconnect("signaling_queue_full");
            return;
        }
        (self.signal_out_bytes, self.signal_out_m_lines) = signal_shape(&data);
        match PendingSignal::new(data, now) {
            Ok(signal) => self.signal = Some(signal),
            Err(reason) => self.disconnect(reason),
        }
    }
    fn flush_signal(&mut self, now: Instant) {
        let Some(mut signal) = self.signal.take() else {
            return;
        };
        let outcome = signal.attempt(now, |payload| {
            self.cid
                .and_then(|id| self.rtc.channel(id))
                .ok_or(())?
                .write(false, payload)
                .map_err(|_| ())
        });
        match outcome {
            Ok(SignalProgress::Sent) => self.signals_sent = self.signals_sent.saturating_add(1),
            Ok(progress) => {
                if progress == SignalProgress::Backpressure {
                    self.signal_backpressure = self.signal_backpressure.saturating_add(1);
                }
                self.signal = Some(signal);
            }
            Err(reason) => self.disconnect(reason),
        }
    }

    pub(crate) fn accepts(&self, input: &Input) -> bool {
        self.rtc.accepts(input)
    }

    pub(crate) fn handle_input(&mut self, input: Input) {
        if !self.rtc.is_alive() {
            return;
        }

        if matches!(&input, Input::Receive(..)) {
            self.received_datagrams = self.received_datagrams.saturating_add(1);
        }
        if self.rtc.handle_input(input).is_err() {
            self.disconnect("input_error");
        }
    }

    pub(crate) fn poll_output(&mut self, socket: &UdpSocket) -> Propagated {
        if !self.rtc.is_alive() {
            return Propagated::Noop;
        }

        let now = Instant::now();
        self.flush_signal(now);
        if self
            .pending_since
            .is_some_and(|at| now.saturating_duration_since(at) >= SIGNAL_ANSWER_TIMEOUT)
        {
            self.disconnect("signaling_answer_timeout");
        }
        if !self.rtc.is_alive() {
            return Propagated::Noop;
        }
        // Incoming tracks from other clients cause new entries in track_out that
        // need SDP negotiation with the remote peer.
        let negotiated = self.negotiate_if_needed();
        self.output_calls += 1;
        self.output_maintenance_us += now.elapsed().as_micros() as u64;
        if negotiated {
            return Propagated::Noop;
        }

        let protocol_at = Instant::now();
        let result = match self.rtc.poll_output() {
            Ok(output) => self.handle_output(output, socket),
            Err(_) => {
                self.disconnect("poll_output_error");
                Propagated::Noop
            }
        };
        self.output_protocol_us += protocol_at.elapsed().as_micros() as u64;
        result
    }

    fn handle_output(&mut self, output: Output, socket: &UdpSocket) -> Propagated {
        match output {
            Output::Transmit(transmit) => {
                self.transmitted_datagrams = self.transmitted_datagrams.saturating_add(1);
                if socket
                    .send_to(&transmit.contents, transmit.destination)
                    .is_err()
                {
                    self.disconnect("udp_send_error");
                }
                Propagated::Noop
            }
            Output::Timeout(t) => Propagated::Timeout(t),
            Output::Event(e) => match e {
                Event::IceConnectionStateChange(v) => {
                    self.ice_state = match v {
                        IceConnectionState::New => "new",
                        IceConnectionState::Checking => "checking",
                        IceConnectionState::Connected => "connected",
                        IceConnectionState::Completed => "completed",
                        IceConnectionState::Disconnected => "disconnected",
                    };
                    if v == IceConnectionState::Disconnected {
                        // Ice disconnect could result in trying to establish a new connection,
                        // but this impl just disconnects directly.
                        self.disconnect("ice_disconnected");
                    }
                    Propagated::Noop
                }
                Event::MediaAdded(e) => self.handle_media_added(e.mid, e.kind),
                Event::MediaData(data) => self.handle_media_data_in(data),
                Event::KeyframeRequest(req) => self.handle_incoming_keyframe_req(req),
                Event::ChannelOpen(cid, _) => {
                    self.cid = Some(cid);
                    self.connected = true;
                    Propagated::Noop
                }
                Event::ChannelData(data) => self.handle_channel_data(data),

                // NB: To see statistics, uncomment set_stats_interval() above.
                Event::MediaIngressStats(data) => {
                    info!("{:?}", data);
                    Propagated::Noop
                }
                Event::MediaEgressStats(data) => {
                    info!("{:?}", data);
                    Propagated::Noop
                }
                Event::PeerStats(data) => {
                    info!("{:?}", data);
                    Propagated::Noop
                }
                _ => Propagated::Noop,
            },
        }
    }

    fn handle_media_added(&mut self, mid: Mid, kind: MediaKind) -> Propagated {
        if self.tracks_in.len() >= 3 {
            self.disconnect("incoming_track_limit");
            return Propagated::Noop;
        }
        let share = kind == MediaKind::Audio
            && self.tracks_in.iter().any(|t| t.id.kind == MediaKind::Audio);
        let track_in = TrackInEntry {
            id: Arc::new(TrackIn {
                origin: self.id,
                mid,
                kind,
                share,
            }),
            last_keyframe_request: None,
        };

        // The Client instance owns the strong reference to the incoming
        // track, all other clients have a weak reference.
        let weak = Arc::downgrade(&track_in.id);
        self.tracks_in.push(track_in);

        Propagated::TrackOpen(self.id, weak)
    }

    fn handle_media_data_in(&mut self, data: MediaData) -> Propagated {
        if data.data.len() > 4 * 1024 * 1024 {
            self.disconnect("incoming_frame_limit");
            return Propagated::Noop;
        }
        self.received_frames = self.received_frames.saturating_add(1);
        if !data.contiguous {
            self.request_keyframe_throttled(data.mid, data.rid, KeyframeRequestKind::Fir);
        }

        Propagated::MediaData(self.id, data)
    }

    fn request_keyframe_throttled(
        &mut self,
        mid: Mid,
        rid: Option<Rid>,
        kind: KeyframeRequestKind,
    ) {
        let Some(mut writer) = self.rtc.writer(mid) else {
            return;
        };

        let Some(track_entry) = self.tracks_in.iter_mut().find(|t| t.id.mid == mid) else {
            return;
        };

        if track_entry
            .last_keyframe_request
            .map(|t| t.elapsed() < Duration::from_secs(1))
            .unwrap_or(false)
        {
            return;
        }

        _ = writer.request_keyframe(rid, kind);

        track_entry.last_keyframe_request = Some(Instant::now());
    }

    fn handle_incoming_keyframe_req(&self, mut req: KeyframeRequest) -> Propagated {
        // Need to figure out the track_in mid that needs to handle the keyframe request.
        let Some(track_out) = self.tracks_out.iter().find(|t| t.mid() == Some(req.mid)) else {
            return Propagated::Noop;
        };
        let Some(track_in) = track_out.track_in.upgrade() else {
            return Propagated::Noop;
        };

        // This is the rid picked from incoming mediadata, and to which we need to
        // send the keyframe request.
        req.rid = self.chosen_rid;

        Propagated::KeyframeRequest(self.id, req, track_in.origin, track_in.mid)
    }

    fn negotiate_if_needed(&mut self) -> bool {
        if self.cid.is_none() || self.pending.is_some() || self.signal.is_some() {
            // Don't negotiate if there is no data channel, or if we have pending changes already.
            return false;
        }

        // An Open track whose origin client disconnected needs its m-line
        // stopped so the remote transceiver transitions to "stopped" and
        // releases its inbound-rtp stats entry.
        for track in &mut self.tracks_out {
            if let TrackOutState::Open(m) = track.state {
                if track.track_in.upgrade().is_none() {
                    track.state = TrackOutState::ToStop(m);
                }
            }
        }

        let mut change = self.rtc.sdp_api();

        for track in &mut self.tracks_out {
            match track.state {
                TrackOutState::ToOpen => {
                    if let Some(track_in) = track.track_in.upgrade() {
                        let stream_id = stream_id(&track_in);
                        let mid = change.add_media(
                            track_in.kind,
                            Direction::SendOnly,
                            Some(stream_id),
                            None,
                            None,
                        );
                        track.state = TrackOutState::Negotiating(mid);
                    }
                }
                TrackOutState::ToStop(mid) => {
                    change.stop_media(mid);
                    track.state = TrackOutState::NegotiatingStop(mid);
                }
                _ => {}
            }
        }

        if !change.has_changes() {
            return false;
        }

        let Some((offer, pending)) = change.apply() else {
            return false;
        };

        let now = Instant::now();
        self.pending = Some(pending);
        self.pending_since = Some(now);
        self.queue_signal(serde_json::to_vec(&offer).unwrap(), now);

        true
    }

    fn handle_channel_data(&mut self, d: ChannelData) -> Propagated {
        (self.signal_in_bytes, self.signal_in_m_lines) = (d.data.len(), 0);
        if d.data.len() > SIGNAL_MAX_BYTES {
            self.disconnect("signaling_message_limit");
            return Propagated::Noop;
        }
        (self.signal_in_bytes, self.signal_in_m_lines) = signal_shape(&d.data);
        if let Ok(offer) = serde_json::from_slice::<'_, SdpOffer>(&d.data) {
            if crate::validate_offer(&offer).is_err() {
                self.disconnect("invalid_remote_offer");
                return Propagated::Noop;
            }
            self.handle_offer(offer);
        } else if let Ok(answer) = serde_json::from_slice::<'_, SdpAnswer>(&d.data) {
            self.handle_answer(answer);
        }

        Propagated::Noop
    }

    fn handle_offer(&mut self, offer: SdpOffer) {
        if self.pending.is_some() {
            self.disconnect("signaling_offer_glare");
            return;
        }
        let Ok(answer) = self.rtc.sdp_api().accept_offer(offer) else {
            self.disconnect("remote_offer_rejected");
            return;
        };

        // Keep local track state in sync, cancelling any pending negotiation
        // so we can redo it after this offer is handled.
        for track in &mut self.tracks_out {
            match track.state {
                TrackOutState::Negotiating(_) => track.state = TrackOutState::ToOpen,
                TrackOutState::NegotiatingStop(m) => {
                    track.state = TrackOutState::ToStop(m);
                }
                _ => {}
            }
        }

        self.queue_signal(serde_json::to_vec(&answer).unwrap(), Instant::now());
    }

    fn handle_answer(&mut self, answer: SdpAnswer) {
        if let Some(pending) = self.pending.take() {
            self.pending_since = None;
            if self.rtc.sdp_api().accept_answer(pending, answer).is_err() {
                self.disconnect("remote_answer_rejected");
                return;
            }

            for track in &mut self.tracks_out {
                if let TrackOutState::Negotiating(m) = track.state {
                    track.state = TrackOutState::Open(m);
                }
            }

            // Drop tracks whose stop negotiation completed. The m-line is
            // now port=0 and eligible for recycling by a later add_media.
            self.tracks_out
                .retain(|t| !matches!(t.state, TrackOutState::NegotiatingStop(_)));
        }
    }

    fn handle_track_open(&mut self, track_in: Weak<TrackIn>) {
        let track_out = TrackOut {
            track_in,
            state: TrackOutState::ToOpen,
        };
        self.tracks_out.push(track_out);
    }

    fn handle_media_data_out(&mut self, origin: ClientId, data: &MediaData) {
        // Figure out which outgoing track maps to the incoming media data.
        let Some(mid) = self
            .tracks_out
            .iter()
            .find(|o| {
                o.track_in
                    .upgrade()
                    .filter(|i| i.origin == origin && i.mid == data.mid)
                    .is_some()
            })
            .and_then(|o| o.mid())
        else {
            return;
        };

        if data.rid.is_some() && data.rid != Some("h".into()) {
            // This is where we plug in a selection strategy for simulcast. For
            // now either let rid=None through (which would be no simulcast layers)
            // or "h" if we have simulcast (see commented out code in chat.html).
            return;
        }

        // Remember this value for keyframe requests.
        if self.chosen_rid != data.rid {
            self.chosen_rid = data.rid;
        }

        let Some(writer) = self.rtc.writer(mid) else {
            self.forwarding_not_ready = self.forwarding_not_ready.saturating_add(1);
            return;
        };

        // Match outgoing pt to incoming codec.
        let Some(pt) = writer.match_params(data.params) else {
            self.forwarding_codec_mismatch = self.forwarding_codec_mismatch.saturating_add(1);
            return;
        };

        self.forwarded_frames = self.forwarded_frames.saturating_add(1);
        self.forwarded_bytes = self.forwarded_bytes.saturating_add(data.data.len() as u64);
        if writer
            .write(pt, data.network_time, data.time, data.data.clone())
            .is_err()
        {
            self.disconnect("media_write_error");
        }
    }

    fn handle_keyframe_request(&mut self, req: KeyframeRequest, mid_in: Mid) {
        let has_incoming_track = self.tracks_in.iter().any(|i| i.id.mid == mid_in);

        // This will be the case for all other client but the one where the track originates.
        if !has_incoming_track {
            return;
        }

        let Some(mut writer) = self.rtc.writer(mid_in) else {
            return;
        };

        if let Err(e) = writer.request_keyframe(req.rid, req.kind) {
            // This can fail if the rid doesn't match any media.
            info!("request_keyframe failed: {:?}", e);
        }
    }
}

/// Events propagated between client.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub(crate) enum Propagated {
    /// When we have nothing to propagate.
    Noop,

    /// Poll client has reached timeout.
    Timeout(Instant),

    /// A new incoming track opened.
    TrackOpen(ClientId, Weak<TrackIn>),

    /// Data to be propagated from one client to another.
    MediaData(ClientId, MediaData),

    /// A keyframe request from one client to the source.
    KeyframeRequest(ClientId, KeyframeRequest, ClientId, Mid),
}

impl Propagated {
    /// Get client id, if the propagated event has a client id.
    fn client_id(&self) -> Option<ClientId> {
        match self {
            Propagated::TrackOpen(c, _)
            | Propagated::MediaData(c, _)
            | Propagated::KeyframeRequest(c, _, _, _) => Some(*c),
            _ => None,
        }
    }
}

pub(crate) fn introduce(client: &mut Client, existing: &[Client]) {
    if client.publisher {
        return;
    }
    let room = client.room.clone();
    for track in existing
        .iter()
        .filter(|p| p.room == room)
        .flat_map(|c| c.tracks_in.iter())
    {
        client.handle_track_open(Arc::downgrade(&track.id));
    }
}
pub(crate) fn propagate(event: &Propagated, clients: &mut [Client]) {
    let Some(source) = event.client_id() else {
        return;
    };
    let Some(room) = clients
        .iter()
        .find(|c| c.id == source)
        .map(|c| c.room.clone())
    else {
        return;
    };
    for client in clients
        .iter_mut()
        .filter(|c| c.room == room && c.id != source)
    {
        match event {
            Propagated::TrackOpen(_, track) if !client.publisher => {
                client.handle_track_open(track.clone())
            }
            Propagated::MediaData(_, data) if !client.publisher => {
                client.handle_media_data_out(source, data)
            }
            Propagated::KeyframeRequest(_, request, origin, mid) if *origin == client.id => {
                client.handle_keyframe_request(*request, *mid)
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publisher_never_subscribes_to_existing_or_new_user_tracks() {
        str0m::crypto::from_feature_flags().install_process_default();
        let now = Instant::now();
        let mut human = Client::new(
            Rtc::new(now),
            "room".into(),
            "human".into(),
            "human-session".into(),
        );
        human.handle_media_added("audio".into(), MediaKind::Audio);
        let mut source = Client::new(
            Rtc::new(now),
            "room".into(),
            "source".into(),
            "source-session".into(),
        );
        source.publisher = true;
        introduce(&mut source, std::slice::from_ref(&human));
        assert!(source.tracks_out.is_empty());
        let viewer = Client::new(
            Rtc::new(now),
            "room".into(),
            "viewer".into(),
            "viewer-session".into(),
        );
        let event = human.handle_media_added("video".into(), MediaKind::Video);
        let mut clients = [human, source, viewer];
        propagate(&event, &mut clients);
        assert!(clients[1].tracks_out.is_empty());
        assert_eq!(clients[2].tracks_out.len(), 1);
        let vm_frame = clients[1].handle_media_added("desktop".into(), MediaKind::Video);
        propagate(&vm_frame, &mut clients);
        assert_eq!(clients[0].tracks_out.len(), 1);
        assert_eq!(clients[2].tracks_out.len(), 2);
        assert!(clients[1].tracks_out.is_empty());
    }
    #[test]
    fn a_second_audio_track_is_share_audio_and_reaches_subscribers_under_its_own_stream() {
        str0m::crypto::from_feature_flags().install_process_default();
        let now = Instant::now();
        let mut sharer = Client::new(Rtc::new(now), "room".into(), "sharer".into(), "s1".into());
        let events = [
            sharer.handle_media_added("0".into(), MediaKind::Audio),
            sharer.handle_media_added("1".into(), MediaKind::Video),
            sharer.handle_media_added("2".into(), MediaKind::Audio),
        ];
        // Three tracks are the limit a publisher may open: voice, picture, share audio.
        assert_eq!(sharer.tracks_in.len(), 3);
        let origin = sharer.id.0.to_string();
        let ids: Vec<String> = sharer.tracks_in.iter().map(|t| stream_id(&t.id)).collect();
        assert_eq!(ids, vec![origin.clone(), origin.clone(), format!("{origin}-share")]);
        let viewer = Client::new(Rtc::new(now), "room".into(), "viewer".into(), "v1".into());
        let mut clients = [sharer, viewer];
        for event in &events {
            propagate(event, &mut clients);
        }
        // The subscriber is offered all three, and the share audio is not folded into the voice track.
        assert_eq!(clients[1].tracks_out.len(), 3);
        let kinds: Vec<(MediaKind, bool)> = clients[1]
            .tracks_out
            .iter()
            .filter_map(|o| o.track_in.upgrade())
            .map(|t| (t.kind, t.share))
            .collect();
        assert_eq!(
            kinds,
            vec![(MediaKind::Audio, false), (MediaKind::Video, false), (MediaKind::Audio, true)]
        );
    }
    #[test]
    fn a_fourth_incoming_track_is_refused() {
        str0m::crypto::from_feature_flags().install_process_default();
        let mut peer = Client::new(Rtc::new(Instant::now()), "room".into(), "p".into(), "s".into());
        for (mid, kind) in [("0", MediaKind::Audio), ("1", MediaKind::Video), ("2", MediaKind::Audio)] {
            peer.handle_media_added(mid.into(), kind);
        }
        assert!(peer.tracks_in.len() == 3 && peer.disconnect_reason.is_none());
        peer.handle_media_added("3".into(), MediaKind::Audio);
        assert_eq!(peer.disconnect_reason, Some("incoming_track_limit"));
    }
    #[test]
    fn signaling_backpressure_preserves_payload_then_sends_once_without_spinning() {
        let start = Instant::now();
        let payload = b"bounded signaling fixture".to_vec();
        let mut queued = Some(PendingSignal::new(payload.clone(), start).unwrap());
        let mut attempts = 0;
        let mut accepted = Vec::new();
        // Multiple output polls during one engine pass must not busy-loop sends.
        for now in [
            start,
            start,
            start + Duration::from_millis(5),
            start + Duration::from_millis(10),
            start + Duration::from_millis(20),
            start + Duration::from_millis(30),
        ] {
            if let Some(signal) = queued.as_mut() {
                let result = signal
                    .attempt(now, |bytes| {
                        attempts += 1;
                        assert_eq!(bytes, payload);
                        if attempts < 3 {
                            return Ok(false);
                        }
                        accepted.push(bytes.to_vec());
                        Ok(true)
                    })
                    .unwrap();
                if result == SignalProgress::Sent {
                    queued = None;
                }
            }
        }
        assert_eq!(attempts, 3);
        assert_eq!(accepted, vec![payload]);
        assert!(queued.is_none());
    }
    #[test]
    fn signaling_backpressure_deadline_and_size_are_bounded() {
        let start = Instant::now();
        assert_eq!(
            PendingSignal::new(vec![0; SIGNAL_MAX_BYTES + 1], start).unwrap_err(),
            "signaling_message_limit"
        );
        let mut signal = PendingSignal::new(vec![0; SIGNAL_MAX_BYTES], start).unwrap();
        assert_eq!(
            signal.attempt(start, |_| Ok(false)),
            Ok(SignalProgress::Backpressure)
        );
        assert_eq!(
            signal.attempt(start + SIGNAL_SEND_TIMEOUT, |_| panic!(
                "expired payload must not be sent"
            )),
            Err("signaling_send_timeout")
        );
        assert_eq!(
            signal.attempt(start + SIGNAL_RETRY_INTERVAL, |_| Err(())),
            Err("signaling_write_error")
        );
    }
}
