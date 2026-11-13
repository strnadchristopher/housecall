import { describe, expect, it } from "vitest";
import { clampVolume, readPrefs, writePrefs, personPrefs, speakerChoice, sinkSupported } from "../src/state/audioOutput";

const memory = () => {
  const store = new Map<string, string>();
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;
};

describe("per-person audio", () => {
  it("defaults to full volume, not muted", () => {
    expect(personPrefs({}, "u1")).toEqual({ volume: 1, muted: false });
  });
  it("clamps volume between 0 and 1", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(3)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(0.4)).toBe(0.4);
  });
  it("remembers a person's volume and mute on this device only", () => {
    const storage = memory();
    writePrefs({ u1: { volume: 0.3, muted: true } }, storage);
    expect(personPrefs(readPrefs(storage), "u1")).toEqual({ volume: 0.3, muted: true });
    expect(personPrefs(readPrefs(storage), "u2")).toEqual({ volume: 1, muted: false });
  });
  it("survives corrupt storage", () => {
    const storage = memory();
    storage.setItem("hc.voicePrefs", "{not json");
    expect(readPrefs(storage)).toEqual({});
  });
  it("speaker choice is empty (system default) until picked, and the picker hides without setSinkId", () => {
    const storage = memory();
    expect(speakerChoice(storage)).toBe("");
    expect(sinkSupported({} as HTMLMediaElement)).toBe(false);
    expect(sinkSupported({ setSinkId: () => Promise.resolve() } as unknown as HTMLMediaElement)).toBe(true);
  });
});
