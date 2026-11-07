use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Plex,
    Dj,
    Vm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Track {
    pub id: String,
    pub title: String,
    /// A normalized provider reference, never a token or private stream URL.
    pub source: String,
    pub duration_ms: u64,
    pub requested_by: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Playback {
    pub media_id: Option<String>,
    pub playing: bool,
    pub position_ms: u64,
    pub anchored_at_ms: u64,
    pub duration_ms: u64,
}
impl Playback {
    pub fn position_at(&self, now_ms: u64) -> u64 {
        let delta = if self.playing {
            now_ms.saturating_sub(self.anchored_at_ms)
        } else {
            0
        };
        self.position_ms.saturating_add(delta).min(self.duration_ms)
    }
    fn anchor(&mut self, now_ms: u64) {
        self.position_ms = self.position_at(now_ms);
        self.anchored_at_ms = now_ms;
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub user_id: String,
    pub expires_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub kind: Kind,
    pub revision: u64,
    pub server_time_ms: u64,
    pub host: String,
    pub members: BTreeSet<String>,
    pub playback: Playback,
    pub queue: VecDeque<Track>,
    pub skip_votes: BTreeSet<String>,
    pub controller: Option<Lease>,
    pub control_requests: VecDeque<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Select { media_id: String, duration_ms: u64 },
    Play {},
    Pause {},
    Seek { position_ms: u64 },
    Enqueue { track: Track },
    Remove { track_id: String },
    VoteSkip {},
    Skip {},
    RequestControl {},
    Handoff { user_id: String },
    RenewControl {},
    ReleaseControl {},
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    state: Snapshot,
}
const LEASE_MS: u64 = 30_000;
const MAX_QUEUE: usize = 500;
impl Session {
    pub fn new(kind: Kind, host: String, members: BTreeSet<String>, now_ms: u64) -> Result<Self> {
        if !members.contains(&host)
            || members.len() > 30
            || members.iter().any(|m| m.is_empty() || m.len() > 128)
        {
            return Err(Error::Invalid("voice membership"));
        }
        Ok(Self {
            state: Snapshot {
                kind,
                host,
                members,
                revision: 0,
                server_time_ms: now_ms,
                playback: Playback {
                    media_id: None,
                    playing: false,
                    position_ms: 0,
                    anchored_at_ms: now_ms,
                    duration_ms: 0,
                },
                queue: VecDeque::new(),
                skip_votes: BTreeSet::new(),
                controller: None,
                control_requests: VecDeque::new(),
            },
        })
    }
    fn member(&self, actor: &str) -> Result<()> {
        if self.state.members.contains(actor) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    fn host(&self, actor: &str) -> Result<()> {
        if self.state.host == actor {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    pub fn snapshot(&self, actor: &str, now_ms: u64) -> Result<Snapshot> {
        self.member(actor)?;
        let mut state = self.state.clone();
        state.server_time_ms = now_ms.max(state.server_time_ms);
        state.playback.anchor(state.server_time_ms);
        if state
            .controller
            .as_ref()
            .is_some_and(|l| l.expires_at_ms <= now_ms)
        {
            state.controller = None;
        }
        Ok(state)
    }
    /// Called only from trusted server voice join/leave handling, never client command input.
    /// If empty, delete the activity instead. A departing host transfers to stable member order.
    pub fn replace_members(&mut self, members: BTreeSet<String>, now_ms: u64) -> Result<()> {
        if members.is_empty()
            || members.len() > 30
            || members.iter().any(|m| m.is_empty() || m.len() > 128)
        {
            return Err(Error::Invalid("voice membership"));
        }
        if members == self.state.members {
            return Ok(());
        }
        if !members.contains(&self.state.host) {
            self.state.host = members.first().unwrap().clone();
        }
        self.state.skip_votes.retain(|u| members.contains(u));
        self.state.control_requests.retain(|u| members.contains(u));
        if self
            .state
            .controller
            .as_ref()
            .is_some_and(|l| !members.contains(&l.user_id))
        {
            self.state.controller = None;
        }
        self.state.members = members;
        self.bump(now_ms);
        Ok(())
    }
    fn bump(&mut self, now_ms: u64) {
        self.state.revision = self.state.revision.saturating_add(1);
        self.state.server_time_ms = now_ms.max(self.state.server_time_ms);
    }
    /// Compare-and-swap prevents stale retries or reordered messages replaying destructive commands.
    /// Errors leave state byte-for-byte unchanged.
    pub fn apply(
        &mut self,
        actor: &str,
        revision: u64,
        command: Command,
        now_ms: u64,
    ) -> Result<Snapshot> {
        self.member(actor)?;
        if revision != self.state.revision {
            return Err(Error::Conflict);
        }
        if now_ms < self.state.server_time_ms {
            return Err(Error::Invalid("clock moved backwards"));
        }
        let mut next = self.clone();
        next.execute(actor, command, now_ms)?;
        next.bump(now_ms);
        let snapshot = next.snapshot(actor, now_ms)?;
        *self = next;
        Ok(snapshot)
    }
    fn execute(&mut self, actor: &str, command: Command, now: u64) -> Result<()> {
        use Command::*;
        if self
            .state
            .controller
            .as_ref()
            .is_some_and(|l| l.expires_at_ms <= now)
        {
            self.state.controller = None;
        }
        match command {
            Select {
                media_id,
                duration_ms,
            } => {
                self.host(actor)?;
                if self.state.kind != Kind::Plex
                    || media_id.is_empty()
                    || !media_id.bytes().all(|c| c.is_ascii_digit())
                    || media_id.len() > 20
                    || duration_ms == 0
                {
                    return Err(Error::Invalid("Plex item"));
                }
                self.state.playback = Playback {
                    media_id: Some(media_id),
                    playing: false,
                    position_ms: 0,
                    anchored_at_ms: now,
                    duration_ms,
                };
            }
            Play {} | Pause {} | Seek { .. } => {
                self.host(actor)?;
                if self.state.kind == Kind::Vm || self.state.playback.media_id.is_none() {
                    return Err(Error::Invalid("no media"));
                }
                self.state.playback.anchor(now);
                match command {
                    Play {} => self.state.playback.playing = true,
                    Pause {} => self.state.playback.playing = false,
                    Seek { position_ms } => {
                        self.state.playback.position_ms =
                            position_ms.min(self.state.playback.duration_ms)
                    }
                    _ => unreachable!(),
                }
            }
            Enqueue { mut track } => {
                if self.state.kind != Kind::Dj
                    || self.state.queue.len() >= MAX_QUEUE
                    || track.id.is_empty()
                    || track.id.len() > 128
                    || track.title.is_empty()
                    || track.title.len() > 512
                    || track.duration_ms == 0
                    || track.duration_ms > 86_400_000
                {
                    return Err(Error::Invalid("track"));
                }
                crate::dj::Source::parse(&track.source)?;
                if self.state.queue.iter().any(|t| t.id == track.id) {
                    return Err(Error::Invalid("duplicate track id"));
                }
                track.requested_by = actor.to_owned();
                self.state.queue.push_back(track);
                if self.state.playback.media_id.is_none() {
                    self.load_front(now);
                }
            }
            Remove { track_id } => {
                if self.state.kind != Kind::Dj {
                    return Err(Error::Invalid("not a DJ session"));
                }
                let idx = self
                    .state
                    .queue
                    .iter()
                    .position(|t| t.id == track_id)
                    .ok_or(Error::Invalid("missing track"))?;
                if self.state.host != actor && self.state.queue[idx].requested_by != actor {
                    return Err(Error::Forbidden);
                }
                self.state.queue.remove(idx);
                if idx == 0 {
                    self.load_front(now);
                }
            }
            VoteSkip {} | Skip {} => {
                if self.state.kind != Kind::Dj || self.state.queue.is_empty() {
                    return Err(Error::Invalid("empty queue"));
                }
                let skip = matches!(command, Skip {});
                if skip {
                    self.host(actor)?;
                } else {
                    self.state.skip_votes.insert(actor.to_owned());
                }
                if skip || self.state.skip_votes.len() > self.state.members.len() / 2 {
                    self.state.queue.pop_front();
                    self.load_front(now);
                }
            }
            RequestControl {} | RenewControl {} | ReleaseControl {} | Handoff { .. } => {
                if self.state.kind != Kind::Vm {
                    return Err(Error::Invalid("not a VM session"));
                }
                let owner = self.state.controller.as_ref().map(|l| l.user_id.as_str());
                match command {
                    RequestControl {} => {
                        if owner.is_none() {
                            self.state.controller = Some(Lease {
                                user_id: actor.to_owned(),
                                expires_at_ms: now.saturating_add(LEASE_MS),
                            });
                            self.state.control_requests.retain(|u| u != actor);
                        } else if owner != Some(actor)
                            && !self.state.control_requests.iter().any(|u| u == actor)
                        {
                            self.state.control_requests.push_back(actor.to_owned());
                        }
                    }
                    RenewControl {} => {
                        if owner != Some(actor) {
                            return Err(Error::Forbidden);
                        }
                        self.state.controller.as_mut().unwrap().expires_at_ms =
                            now.saturating_add(LEASE_MS);
                    }
                    ReleaseControl {} => {
                        if owner != Some(actor) && self.state.host != actor {
                            return Err(Error::Forbidden);
                        }
                        self.state.controller = None;
                    }
                    Handoff { user_id } => {
                        if owner != Some(actor) && self.state.host != actor {
                            return Err(Error::Forbidden);
                        }
                        self.member(&user_id)?;
                        self.state.control_requests.retain(|u| u != &user_id);
                        self.state.controller = Some(Lease {
                            user_id,
                            expires_at_ms: now.saturating_add(LEASE_MS),
                        });
                    }
                    _ => unreachable!(),
                }
            }
        }
        Ok(())
    }
    fn load_front(&mut self, now: u64) {
        self.state.skip_votes.clear();
        self.state.playback = if let Some(track) = self.state.queue.front() {
            Playback {
                media_id: Some(track.id.clone()),
                playing: true,
                position_ms: 0,
                anchored_at_ms: now,
                duration_ms: track.duration_ms,
            }
        } else {
            Playback {
                media_id: None,
                playing: false,
                position_ms: 0,
                anchored_at_ms: now,
                duration_ms: 0,
            }
        };
    }
    /// Trusted timer advancement; publish returned snapshot after persistence.
    pub fn tick(&mut self, now_ms: u64) -> Option<Snapshot> {
        let now_ms = now_ms.max(self.state.server_time_ms);
        let ended = self.state.playback.playing
            && self.state.playback.position_at(now_ms) >= self.state.playback.duration_ms;
        let expired = self
            .state
            .controller
            .as_ref()
            .is_some_and(|l| l.expires_at_ms <= now_ms);
        if !ended && !expired {
            return None;
        }
        if ended {
            if self.state.kind == Kind::Dj {
                self.state.queue.pop_front();
                self.load_front(now_ms);
            } else {
                self.state.playback.anchor(now_ms);
                self.state.playback.playing = false;
            }
        }
        if expired {
            self.state.controller = None;
        }
        self.bump(now_ms);
        self.snapshot(&self.state.host, now_ms).ok()
    }
    /// Check at the VM input gateway for EVERY input packet, including cached sockets.
    pub fn authorize_input(&self, actor: &str, now_ms: u64) -> Result<()> {
        self.member(actor)?;
        if self.state.kind == Kind::Vm
            && self
                .state
                .controller
                .as_ref()
                .is_some_and(|l| l.user_id == actor && l.expires_at_ms > now_ms)
        {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
}
