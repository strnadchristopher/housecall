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
    pub received_frames: u64,
    pub forwarded_frames: u64,
    pub forwarded_bytes: u64,
    pub id: ClientId,
    pub rtc: Rtc,
    pending: Option<SdpPendingOffer>,
    cid: Option<ChannelId>,
    tracks_in: Vec<TrackInEntry>,
    tracks_out: Vec<TrackOut>,
    chosen_rid: Option<Rid>,
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
            received_frames: 0,
            forwarded_frames: 0,
            forwarded_bytes: 0,
            id: ClientId(next_id),
            rtc,
            pending: None,
            cid: None,
            tracks_in: vec![],
            tracks_out: vec![],
            chosen_rid: None,
        }
    }

    pub(crate) fn accepts(&self, input: &Input) -> bool {
        self.rtc.accepts(input)
    }

    pub(crate) fn handle_input(&mut self, input: Input) {
        if !self.rtc.is_alive() {
            return;
        }

        if let Err(e) = self.rtc.handle_input(input) {
            warn!("Client ({}) disconnected: {:?}", *self.id, e);
            self.rtc.disconnect();
        }
    }

    pub(crate) fn poll_output(&mut self, socket: &UdpSocket) -> Propagated {
        if !self.rtc.is_alive() {
            return Propagated::Noop;
        }

        // Incoming tracks from other clients cause new entries in track_out that
        // need SDP negotiation with the remote peer.
        if self.negotiate_if_needed() {
            return Propagated::Noop;
        }

        match self.rtc.poll_output() {
            Ok(output) => self.handle_output(output, socket),
            Err(e) => {
                warn!("Client ({}) poll_output failed: {:?}", *self.id, e);
                self.rtc.disconnect();
                Propagated::Noop
            }
        }
    }

    fn handle_output(&mut self, output: Output, socket: &UdpSocket) -> Propagated {
        match output {
            Output::Transmit(transmit) => {
                if socket
                    .send_to(&transmit.contents, transmit.destination)
                    .is_err()
                {
                    self.rtc.disconnect();
                }
                Propagated::Noop
            }
            Output::Timeout(t) => Propagated::Timeout(t),
            Output::Event(e) => match e {
                Event::IceConnectionStateChange(v) => {
                    if v == IceConnectionState::Disconnected {
                        // Ice disconnect could result in trying to establish a new connection,
                        // but this impl just disconnects directly.
                        self.rtc.disconnect();
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
            self.rtc.disconnect();
            return Propagated::Noop;
        }
        let track_in = TrackInEntry {
            id: Arc::new(TrackIn {
                origin: self.id,
                mid,
                kind,
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
            self.rtc.disconnect();
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
        if self.cid.is_none() || self.pending.is_some() {
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
                        let stream_id = track_in.origin.to_string();
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

        let Some(mut channel) = self.cid.and_then(|id| self.rtc.channel(id)) else {
            return false;
        };

        let json = serde_json::to_string(&offer).unwrap();
        if !matches!(channel.write(false, json.as_bytes()), Ok(true)) {
            self.rtc.disconnect();
            return false;
        }

        self.pending = Some(pending);

        true
    }

    fn handle_channel_data(&mut self, d: ChannelData) -> Propagated {
        if d.data.len() > 128 * 1024 {
            self.rtc.disconnect();
            return Propagated::Noop;
        }
        if let Ok(offer) = serde_json::from_slice::<'_, SdpOffer>(&d.data) {
            if crate::validate_offer(&offer).is_err() {
                self.rtc.disconnect();
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
            self.rtc.disconnect();
            return;
        }
        let Ok(answer) = self.rtc.sdp_api().accept_offer(offer) else {
            self.rtc.disconnect();
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

        let Some(mut channel) = self.cid.and_then(|id| self.rtc.channel(id)) else {
            self.rtc.disconnect();
            return;
        };

        let json = serde_json::to_string(&answer).unwrap();
        if !matches!(channel.write(false, json.as_bytes()), Ok(true)) {
            self.rtc.disconnect();
        }
    }

    fn handle_answer(&mut self, answer: SdpAnswer) {
        if let Some(pending) = self.pending.take() {
            if self.rtc.sdp_api().accept_answer(pending, answer).is_err() {
                self.rtc.disconnect();
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
            return;
        };

        // Match outgoing pt to incoming codec.
        let Some(pt) = writer.match_params(data.params) else {
            return;
        };

        self.forwarded_frames = self.forwarded_frames.saturating_add(1);
        self.forwarded_bytes = self.forwarded_bytes.saturating_add(data.data.len() as u64);
        if let Err(e) = writer.write(pt, data.network_time, data.time, data.data.clone()) {
            warn!("Client ({}) failed: {:?}", *self.id, e);
            self.rtc.disconnect();
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
            Propagated::TrackOpen(_, track) => client.handle_track_open(track.clone()),
            Propagated::MediaData(_, data) => client.handle_media_data_out(source, data),
            Propagated::KeyframeRequest(_, request, origin, mid) if *origin == client.id => {
                client.handle_keyframe_request(*request, *mid)
            }
            _ => {}
        }
    }
}
