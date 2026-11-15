/**
 * CallTransport: one call at a time, in a conversation. The UI drives it
 * from the call bar, the call dock and the stage. adapters/legacy implements
 * it on the current SFU; adapters/livekit will replace it in Phase 3.
 */
export interface CallParticipant {
  id: string;
  personId: string;
  name: string;
  avatarUrl?: string;
  me: boolean;
  connected: boolean;
}

/** Audio level (0 to 1, as reported by getStats) above which a participant counts as speaking. */
export const SPEAKING_LEVEL = 0.02;
export function isSpeaking(level: number | undefined): boolean {
  return typeof level === "number" && level > SPEAKING_LEVEL;
}

/** One person inside a voice room, with the state the server reports (docs/API.md). */
export interface VoiceRoomMember {
  personId: string;
  name: string;
  avatarUrl?: string;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  joinedAt: number;
}

export interface CallMedia {
  id: string;
  stream: MediaStream;
  /** Participant that published it, when the transport can tell. */
  participantId?: string;
  video: boolean;
  /** The sound of a shared screen, not the person's voice. It has its own volume. */
  share?: boolean;
}

export interface CallDevice {
  id: string;
  label: string;
  kind: "microphone" | "camera";
}

/** Someone is calling you in a direct conversation and you have not answered yet. */
export interface IncomingCall {
  conversationId: string;
  personId: string;
  name: string;
  avatarUrl?: string;
}

export interface CallState {
  /** A ring for you that is still live (30 s). Cleared by answering, declining, the caller cancelling or timing out. */
  incoming?: IncomingCall;
  /** While you are the caller in a direct conversation and nobody else has joined: ringing, or the other person declined. */
  outgoing?: "ringing" | "declined";
  /** False when the server has no voice transport: no call control is rendered. */
  available: boolean;
  phase: "idle" | "connecting" | "live" | "failed";
  /** Recovering an established media or signaling connection; retain the last roster. */
  reconnecting?: boolean;
  conversationId?: string;
  conversationName?: string;
  /** Known only while this client is in the call (backend limit). */
  participants: CallParticipant[];
  /** Who is in a call right now, by conversation id, for every conversation you can open. Read before joining. */
  active: Record<string, { personId: string; name: string; avatarUrl?: string }[]>;
  /** The same rooms with each person's state, streamers first (see state/voiceRoster.ts). */
  rooms: Record<string, VoiceRoomMember[]>;
  media: CallMedia[];
  /** Ids of participants whose audio is above the speaking threshold right now (sampled at 4 Hz). */
  speaking: string[];
  /** Your own outgoing picture (camera, or the screen while sharing), for your tile. */
  localVideo?: MediaStream;
  /** When this client joined, in epoch milliseconds. */
  joinedAt?: number;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  /** The preset a share uses, or will use: "smooth", "sharp" or "source". Remembered on this device. */
  shareQuality: "smooth" | "sharp" | "source";
  /** Your share is going out with sound. */
  sharingSound: boolean;
  error: string;
  /** Non-fatal notice, e.g. a saved device was replaced by the default. */
  warning: string;
  devices: CallDevice[];
  selected: { microphone?: string; camera?: string };
  bitrate: number;
  noiseSuppression: boolean;
  stats: { receivedBytes: number; decodedFrames: number };
  /** Measured by getStats(): round-trip time in ms and packet loss as a fraction. Absent until measured. */
  quality: { rttMs?: number; loss?: number };
}

export interface CallTransport extends CallState {
  join(conversationId: string): Promise<void>;
  /**
   * Calls one person: opens (or finds) your direct conversation with them, joins its voice room and
   * rings them. The caller leaves by itself after 45 s unanswered or a few seconds after a decline.
   */
  callPerson(personId: string): Promise<void>;
  /** Answers `incoming`: joins that conversation's call. */
  accept(): Promise<void>;
  /** Declines `incoming` and tells the caller. */
  decline(): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  setCamera(on: boolean): Promise<void>;
  setSharing(on: boolean): Promise<void>;
  /** Picks the preset for the next share and, if one is running, applies it at once. */
  setShareQuality(quality: "smooth" | "sharp" | "source"): Promise<void>;
  refreshDevices(): Promise<void>;
  selectDevices(selected: { microphone?: string; camera?: string }): void;
  setAudio(bitrate: number, noiseSuppression: boolean): Promise<void>;
}

/** Local audio choices remain available while an established call recovers. */
export function canControlLocalAudio(call: Pick<CallState, "phase" | "reconnecting">): boolean {
  return call.phase === "live" || call.phase === "connecting" && !!call.reconnecting;
}
