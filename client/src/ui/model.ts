/**
 * Presentation view models for client/src/ui.
 *
 * The v1 contract (client/src/contracts/ui.ts) only defines the generic
 * Screen fixture. These are the shapes the designed components render.
 * Engineering adapts state into them; see docs/UI-REQUESTS.md (R-1).
 * IDs are opaque strings, timestamps epoch ms, byte sizes decimal strings.
 */
import type { Phase, ScreenId, AudioPreferences } from '../contracts/ui';
import type { ThemeId } from './tokens/themes';

export type { Phase, ScreenId, AudioPreferences, ThemeId };

export type Platform = 'desktop' | 'ios' | 'android';
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type Connection = 'connecting' | 'online' | 'offline' | 'reconnecting' | 'revoked';

export interface UserView {
  id: string;
  name: string;
  /** Optional authenticated avatar URL. Monogram stone otherwise. */
  avatarUrl?: string;
  presence: Presence;
  isOwner?: boolean;
  roles?: string[];
  /** Free text status line. */
  status?: string;
}

export interface ServerView { id: string; name: string; unread: boolean; mentions: number }

export interface VoiceOccupant { userId: string; speaking?: boolean; muted?: boolean; deafened?: boolean; camera?: boolean; screen?: boolean }

export type ActivityKind = 'plex' | 'dj' | 'vm';

export interface ChannelView {
  id: string;
  serverId: string;
  name: string;
  kind: 'text' | 'voice';
  topic?: string;
  unread: boolean;
  mentions: number;
  muted?: boolean;
  /** Voice channels: who is in there right now. */
  occupants?: VoiceOccupant[];
  activity?: ActivityKind;
  /** Optional group label ("Text", "Voice", "Projects"). */
  group?: string;
}

export interface DMView {
  id: string;
  kind: 'dm' | 'group_dm';
  name: string;
  memberIds: string[];
  unread: boolean;
  mentions: number;
  lastExcerpt?: string;
  lastAt?: number;
}

/** Sanitised inline tokens. Engineering may supply these; otherwise the UI tokenises plain text itself (never raw HTML). */
export type InlineToken =
  | { t: 'text'; v: string }
  | { t: 'bold' | 'italic' | 'strike'; v: InlineToken[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string }
  | { t: 'mention'; kind: 'user' | 'role' | 'everyone'; id?: string; v: string }
  | { t: 'emoji'; v: string };
export type BlockToken = { t: 'p'; v: InlineToken[] } | { t: 'pre'; lang?: string; v: string } | { t: 'quote'; v: InlineToken[] };

export interface ReactionView { emoji: string; count: number; mine: boolean; names?: string[] }

export type ScanState = 'pending' | 'clean' | 'quarantined';
export type UploadState = 'hashing' | 'uploading' | 'paused' | 'interrupted' | 'disk_full' | 'scanning' | 'transcoding' | 'quarantined' | 'ready' | 'failed';

export interface UploadView {
  id: string;
  name: string;
  /** Decimal byte strings. */
  sent: string;
  total: string;
  state: UploadState;
  /** Bytes per second, display only. */
  rate?: number;
  error?: string;
}

export interface AttachmentView {
  id: string;
  name: string;
  size: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  mime?: string;
  url?: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
  /** Seconds. */
  duration?: number;
  scan: ScanState;
  /** Present while still uploading/processing. */
  upload?: UploadView;
}

export interface EmbedView { url: string; site: string; title: string; description?: string; imageUrl?: string }
export interface GifView { id: string; url: string; previewUrl?: string; width: number; height: number; title?: string }

export interface SystemEvent {
  kind: 'gimme' | 'join' | 'pin' | 'activity' | 'call';
  text: string;
  /** For gimme updates. */
  gimme?: GimmeRequestView;
}

export interface MessageView {
  id: string;
  authorId: string;
  body?: string;
  tokens?: BlockToken[];
  createdAt: number;
  editedAt?: number;
  revision?: number;
  state: 'pending' | 'sent' | 'failed';
  error?: string;
  replyTo?: { id: string; authorId: string; excerpt: string; deleted?: boolean };
  reactions?: ReactionView[];
  attachments?: AttachmentView[];
  embeds?: EmbedView[];
  gif?: GifView;
  pinned?: boolean;
  mentionsMe?: boolean;
  thread?: { count: number; lastAt: number; participantIds: string[] };
  system?: SystemEvent;
}

export interface Permissions {
  send: boolean;
  react: boolean;
  pin: boolean;
  manage: boolean;
  /** Reason shown when send is false. */
  sendReason?: string;
}

export interface ConversationView {
  id: string;
  kind: 'channel' | 'dm' | 'group_dm';
  title: string;
  topic?: string;
  phase: Phase;
  error?: string;
  messages: MessageView[];
  /** First unread message ID, for the "new" divider. */
  unreadFromId?: string;
  typingIds: string[];
  permissions: Permissions;
  hasOlder: boolean;
  loadingOlder?: boolean;
  /** Message the composer is replying to. */
  replyTo?: MessageView;
  /** Message being edited inline. */
  editingId?: string;
  memberIds: string[];
}

export interface MentionCandidate { kind: 'user' | 'role' | 'everyone'; id: string; label: string; detail?: string; userId?: string; disabled?: boolean; reason?: string }

export interface ComposerView {
  draft: string;
  uploads: UploadView[];
  /** Server-reported command validation error. */
  commandError?: string;
  sending?: boolean;
  sendError?: string;
}

export interface ThreadView { parent?: MessageView; parentDeleted?: boolean; replies: MessageView[]; phase: Phase; subscribed: boolean; participantIds: string[] }
export interface SearchResultView { message: MessageView; channelName: string; deleted?: boolean }
export interface SearchView { query: string; phase: Phase; results: SearchResultView[]; hasMore: boolean; scope?: string }
export interface PinsView { phase: Phase; messages: MessageView[]; canUnpin: boolean }
export interface MembersView { phase: Phase; memberIds: string[]; roles: { id: string; name: string; memberIds: string[] }[]; canManage: boolean }

export interface GifPickerView { phase: Phase; query: string; results: GifView[]; error?: string; hasMore: boolean; attribution: string }

export interface CallQuality { requestedBitrate: number; negotiatedBitrate?: number; rttMs?: number; jitterMs?: number; lossPct?: number; stereo: boolean; noiseSuppression: boolean }
export interface CallParticipant extends VoiceOccupant { userId: string; level?: number; /** Live video, engineering-owned. */ stream?: MediaStream; screenStream?: MediaStream; connection?: 'good' | 'poor' | 'reconnecting' }
export interface DeviceOption { id: string; label: string }

export interface CallView {
  channelId: string;
  channelName: string;
  state: 'requesting' | 'denied' | 'connecting' | 'reconnecting' | 'live' | 'ended';
  error?: string;
  participants: CallParticipant[];
  self: { muted: boolean; deafened: boolean; camera: boolean; screen: boolean };
  quality: CallQuality;
  devices: { inputs: DeviceOption[]; outputs: DeviceOption[]; cameras: DeviceOption[]; input?: string; output?: string; camera?: string };
  /** Screen share or camera source ended by the OS. */
  sourceEnded?: 'camera' | 'screen';
  activity?: ActivityView;
  capabilities: Record<ActivityKind, { available: boolean; reason?: string }>;
}

export type ActivityView =
  | { kind: 'plex'; plex: PlexView }
  | { kind: 'dj'; dj: DjView }
  | { kind: 'vm'; vm: VmView };

export interface PlexItem { id: string; title: string; year?: number; kind: 'movie' | 'show' | 'episode'; durationS?: number; posterUrl?: string; summary?: string; rating?: string; tint?: string }
export interface PlexView {
  phase: Phase;
  error?: string;
  query: string;
  library: PlexItem[];
  section: 'movies' | 'shows';
  selected?: PlexItem;
  playback?: {
    state: 'playing' | 'paused' | 'buffering' | 'transcoding' | 'ended';
    positionS: number;
    durationS: number;
    revision: number;
    stale?: boolean;
    subtitles: { id: string; label: string }[];
    subtitleId?: string;
    viewerIds: string[];
    controllerId?: string;
  };
}

export type TrackSource = 'youtube' | 'soundcloud' | 'spotify' | 'search';
export interface DjTrack { id: string; title: string; artist: string; source: TrackSource; durationS: number; artUrl?: string; tint?: string }
export interface DjQueueItem { id: string; track?: DjTrack; query: string; requestedBy: string; state: 'resolving' | 'ready' | 'no_source' | 'failed'; votes: number; myVote: boolean; error?: string }
export interface DjView {
  phase: Phase;
  error?: string;
  nowPlaying?: { track: DjTrack; positionS: number; requestedBy: string };
  playing: boolean;
  queue: DjQueueItem[];
  skip: { votes: number; needed: number; mine: boolean };
  speech: { state: 'idle' | 'writing' | 'speaking' | 'tts_unavailable'; line?: string };
  hostId: string;
  revision: number;
}

export interface VmView {
  state: 'starting' | 'vpn_down' | 'live' | 'resetting' | 'error';
  error?: string;
  controllerId?: string;
  leaseEndsAt?: number;
  requestIds: string[];
  me: 'viewing' | 'requested' | 'controlling';
  vpn: { up: boolean; exit?: string; checkedAt?: number };
  snapshot: { name: string; takenAt: number };
  resolution: string;
  stream?: MediaStream;
}

export type GimmePhase = 'dry_run' | 'accepted' | 'pending' | 'downloading' | 'completed' | 'already_owned' | 'needs_confirmation' | 'unavailable' | 'failed';
export interface GimmeResultView { id: string; title: string; year?: number; type: 'movie' | 'show'; owned?: boolean; tint?: string }
export interface GimmeRequestView { id: string; title: string; year?: number; type: 'movie' | 'show'; phase: GimmePhase; progress?: number; requestedBy: string; at: number; note?: string }
export interface GimmeView { phase: Phase; error?: string; query: string; type: 'movie' | 'show'; results: GimmeResultView[]; requests: GimmeRequestView[]; dryRun: boolean }

export interface NotificationView { id: string; messageId: string; channelName: string; authorId: string; excerpt: string; at: number; read: boolean; retracted?: boolean }
export interface NotificationsView { phase: Phase; items: NotificationView[]; push: 'granted' | 'denied' | 'default' | 'unavailable'; pushReason?: string }

export interface NotificationPrefs { desktop: boolean; sounds: boolean; mentionsOnly: boolean; push: 'granted' | 'denied' | 'default' | 'unavailable' }
export interface SessionView { id: string; name: string; platform: Platform | 'web' | 'linux' | 'windows' | 'macos'; createdAt: number; lastSeenAt: number; current: boolean }
export interface CredentialView { id: string; kind: 'passkey' | 'recovery'; label: string; createdAt: number }
export interface SettingsView {
  theme: ThemeId;
  audio: AudioPreferences;
  notifications: NotificationPrefs;
  cacheBytes: string;
  sessions: SessionView[];
  credentials: CredentialView[];
  saved: 'saved' | 'saving' | 'unsaved' | 'error';
  error?: string;
}

export interface InviteView { id: string; createdAt: number; expiresAt: number; state: 'active' | 'used' | 'expired' | 'revoked'; usedBy?: string; note?: string }
export interface ReportView { id: string; kind: 'bug' | 'feature'; authorId: string; body: string; createdAt: number; status: 'open' | 'resolved'; screenshotUrl?: string; logs?: string[]; platform?: string }
export interface AdminView {
  phase: Phase;
  invites: InviteView[];
  /** Plain link, shown exactly once after issuing. */
  freshInvite?: { id: string; link: string; expiresAt: number };
  reports: ReportView[];
  reportFilter: 'open' | 'resolved' | 'all';
  userIds: string[];
}

export interface ReportDraftView { kind: 'bug' | 'feature'; phase: 'editing' | 'submitting' | 'sent' | 'error'; error?: string; screenshotUrl?: string; logPreview?: string[] }

export type Route =
  | { kind: 'channel'; id: string }
  | { kind: 'dm'; id: string }
  | { kind: 'call' }
  | { kind: 'home' };

export type Panel = 'thread' | 'members' | 'pins' | 'search' | null;
export type Overlay = 'settings' | 'admin' | 'report' | 'gimme' | 'new-dm' | 'notifications' | null;

export interface OnboardingView {
  flow: 'setup' | 'invite' | 'login';
  step: 'details' | 'passkey' | 'fallback' | 'joined';
  phase: Phase;
  busy?: boolean;
  error?: string;
  instanceName: string;
  inviter?: string;
  expiresAt?: number;
  invite?: 'valid' | 'expired' | 'used' | 'invalid';
  passkey: 'supported' | 'unsupported' | 'cancelled' | 'idle';
  rememberedName?: string;
  insecureOrigin?: boolean;
  throttledUntil?: number;
  /** Seconds since the invite link was opened, for the "under a minute" promise. */
  elapsedS?: number;
}

/** Everything the shell renders. */
export interface AppView {
  platform: Platform;
  connection: Connection;
  reconnectInS?: number;
  me: UserView;
  users: Record<string, UserView>;
  servers: ServerView[];
  serverId: string;
  channels: ChannelView[];
  dms: DMView[];
  route: Route;
  panel: Panel;
  overlay: Overlay;
  conversation?: ConversationView;
  composer: ComposerView;
  mentionCandidates: MentionCandidate[];
  thread?: ThreadView;
  search?: SearchView;
  pins?: PinsView;
  members?: MembersView;
  gifs?: GifPickerView;
  call?: CallView;
  /** Call stage expanded (desktop) / full screen (mobile). */
  callExpanded?: boolean;
  gimme?: GimmeView;
  notifications?: NotificationsView;
  settings?: SettingsView;
  admin?: AdminView;
  report?: ReportDraftView;
}
