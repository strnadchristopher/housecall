/** Who is in each voice room and in what state (docs/API.md, "Live voice state and events"). */
export interface VoiceMember {
  personId: string;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  joinedAt: number;
}
export type VoiceRooms = Record<string, VoiceMember[]>;
interface StateRecord { user_id: string; muted?: boolean; deafened?: boolean; camera?: boolean; sharing?: boolean; joined_at?: number }

const member = (r: StateRecord): VoiceMember => ({ personId: r.user_id, muted: !!r.muted, deafened: !!r.deafened, camera: !!r.camera, sharing: !!r.sharing, joinedAt: r.joined_at ?? 0 });

/** Everyone sharing a screen first, then the rest; each group by joinedAt. */
export function sortRoster(people: VoiceMember[]): VoiceMember[] {
  return [...people].sort((a, b) => Number(b.sharing) - Number(a.sharing) || a.joinedAt - b.joinedAt);
}

/** `states` is the 0.4.0 answer; `rooms` (user ids only) is all a 0.3.0 server sends. */
export function roomsFromStates(states: Record<string, StateRecord[]> | undefined, rooms: Record<string, string[]> | undefined): VoiceRooms {
  if (states) return Object.fromEntries(Object.entries(states).filter(([, list]) => list.length).map(([id, list]) => [id, list.map(member)]));
  return Object.fromEntries(Object.entries(rooms ?? {}).filter(([, ids]) => ids.length).map(([id, ids]) => [id, ids.map((personId, i) => ({ personId, muted: false, deafened: false, camera: false, sharing: false, joinedAt: i }))]));
}

/** Returns the new rooms for a voice.* event, or undefined when the event is not one. */
export function applyVoiceEvent(rooms: VoiceRooms, event: { kind: string; channel_id?: string; payload: Record<string, unknown> }): VoiceRooms | undefined {
  if (event.kind !== "voice.joined" && event.kind !== "voice.state" && event.kind !== "voice.left") return undefined;
  const channel = typeof event.payload.channel_id === "string" ? event.payload.channel_id : event.channel_id;
  const user = event.payload.user_id;
  if (!channel || typeof user !== "string") return undefined;
  const others = (rooms[channel] ?? []).filter(p => p.personId !== user);
  const next = { ...rooms };
  if (event.kind === "voice.left") {
    if (others.length) next[channel] = others; else delete next[channel];
    return next;
  }
  next[channel] = [...others, member(event.payload as unknown as StateRecord)];
  return next;
}
