import { describe, expect, it } from "vitest";
import { applyVoiceEvent, sortRoster, roomsFromStates, type VoiceMember, type VoiceRooms } from "../src/state/voiceRoster";

const m = (personId: string, joinedAt: number, extra: Partial<VoiceMember> = {}): VoiceMember => ({ personId, muted: false, deafened: false, camera: false, sharing: false, joinedAt, ...extra });

describe("voice roster", () => {
  it("lists people sharing first, then everyone else, each by joined_at", () => {
    const sorted = sortRoster([m("a", 1), m("b", 2, { sharing: true }), m("c", 3), m("d", 4, { sharing: true })]);
    expect(sorted.map(p => p.personId)).toEqual(["b", "d", "a", "c"]);
  });
  it("applies joined, state and left events", () => {
    let rooms: VoiceRooms = {};
    rooms = applyVoiceEvent(rooms, { kind: "voice.joined", channel_id: "c1", payload: { channel_id: "c1", user_id: "u1", muted: false, deafened: false, camera: false, sharing: false, joined_at: 5 } })!;
    expect(rooms.c1.map(p => p.personId)).toEqual(["u1"]);
    rooms = applyVoiceEvent(rooms, { kind: "voice.state", channel_id: "c1", payload: { channel_id: "c1", user_id: "u1", muted: true, deafened: false, camera: false, sharing: true, joined_at: 5 } })!;
    expect(rooms.c1[0]).toMatchObject({ muted: true, sharing: true });
    rooms = applyVoiceEvent(rooms, { kind: "voice.left", channel_id: "c1", payload: { channel_id: "c1", user_id: "u1" } })!;
    expect(rooms.c1).toBeUndefined();
  });
  it("ignores other events and keeps a joined person once", () => {
    expect(applyVoiceEvent({}, { kind: "message.created", payload: {} })).toBeUndefined();
    const once = { kind: "voice.joined", channel_id: "c", payload: { channel_id: "c", user_id: "u", joined_at: 1 } };
    const rooms = applyVoiceEvent(applyVoiceEvent({}, once)!, once)!;
    expect(rooms.c).toHaveLength(1);
  });
  it("builds rooms from the polled states", () => {
    const rooms = roomsFromStates({ c: [{ user_id: "u", muted: true, deafened: false, camera: true, sharing: false, joined_at: 2 }] }, { c: ["u"] });
    expect(rooms.c[0]).toMatchObject({ personId: "u", muted: true, camera: true });
  });
  it("falls back to bare ids when the server sends no states", () => {
    expect(roomsFromStates(undefined, { c: ["u", "v"] }).c.map(p => p.personId)).toEqual(["u", "v"]);
  });
});
