/** A ring or decline from the event poll, handed to whoever runs the call (adapters/legacy/call.ts). */
export interface CallEvent {
  kind: "call.ring" | "call.declined";
  channelId: string;
  fromId: string;
  fromName?: string;
  /** False for an event replayed after sign-in: a ring that old is no longer ringing. */
  fresh: boolean;
}

/** An event is a live ring only for this long after the server wrote it. */
export const RING_FRESH_MS = 30000;

type Listener = (event: CallEvent) => void;

export class CallEvents {
  private listeners = new Set<Listener>();
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: CallEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** Age is judged on the server clock (`serverNow` comes with every poll), never this device's. */
export function toCallEvent(event: { kind: string; channel_id?: string; payload: Record<string, unknown>; created_at: number }, serverNow: unknown): CallEvent | undefined {
  if (event.kind !== "call.ring" && event.kind !== "call.declined") return undefined;
  const channelId = typeof event.payload.channel_id === "string" ? event.payload.channel_id : event.channel_id;
  const fromId = event.payload.from;
  if (!channelId || typeof fromId !== "string") return undefined;
  return {
    kind: event.kind,
    channelId,
    fromId,
    fromName: typeof event.payload.from_name === "string" ? event.payload.from_name : undefined,
    fresh: typeof serverNow === "number" && serverNow - event.created_at < RING_FRESH_MS,
  };
}
