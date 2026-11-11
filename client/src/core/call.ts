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

export interface CallMedia {
  id: string;
  stream: MediaStream;
  /** Participant that published it, when the transport can tell. */
  participantId?: string;
  video: boolean;
}

export interface CallDevice {
  id: string;
  label: string;
  kind: "microphone" | "camera";
}

export interface CallState {
  /** False when the server has no voice transport: no call control is rendered. */
  available: boolean;
  phase: "idle" | "connecting" | "live" | "failed";
  conversationId?: string;
  conversationName?: string;
  /** Known only while this client is in the call (backend limit). */
  participants: CallParticipant[];
  /** Who is in a call right now, by conversation id, for every conversation you can open. Read before joining. */
  active: Record<string, { personId: string; name: string; avatarUrl?: string }[]>;
  media: CallMedia[];
  /** When this client joined, in epoch milliseconds. */
  joinedAt?: number;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  error: string;
  /** Non-fatal notice, e.g. a saved device was replaced by the default. */
  warning: string;
  devices: CallDevice[];
  selected: { microphone?: string; camera?: string };
  bitrate: number;
  noiseSuppression: boolean;
  stats: { receivedBytes: number; decodedFrames: number };
}

export interface CallTransport extends CallState {
  join(conversationId: string): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  setCamera(on: boolean): Promise<void>;
  setSharing(on: boolean): Promise<void>;
  refreshDevices(): Promise<void>;
  selectDevices(selected: { microphone?: string; camera?: string }): void;
  setAudio(bitrate: number, noiseSuppression: boolean): Promise<void>;
}
