import { describe, expect, it } from "vitest";
import { MAX_GAIN, gainFor, loadSoundSettings, phrase, saveSoundSettings, RING_EVERY_MS, RINGBACK_EVERY_MS, type SoundName } from "../src/state/sounds";

const note = (name: SoundName) => phrase(name);

describe("sound palette", () => {
  it("join is E5 then B5, leave is B5 then E5, two 90 ms notes", () => {
    const join = note("join"), leave = note("leave");
    expect(join.map(n => Math.round(n.freq))).toEqual([659, 988]);
    expect(leave.map(n => Math.round(n.freq))).toEqual([988, 659]);
    expect(join.every(n => n.dur === 0.09)).toBe(true);
  });
  it("mute is 440 to 330 Hz in 60 ms, unmute is the reverse; deafen is an octave lower", () => {
    expect(note("mute").map(n => n.freq)).toEqual([440, 330]);
    expect(note("unmute").map(n => n.freq)).toEqual([330, 440]);
    expect(note("deafen").map(n => n.freq)).toEqual([220, 165]);
    expect(note("undeafen").map(n => n.freq)).toEqual([165, 220]);
    expect(note("mute")[0].dur).toBeCloseTo(0.06);
  });
  it("stream start is three rising notes and the ring is a four-note phrase", () => {
    const rising = note("stream").map(n => n.freq);
    expect(rising).toHaveLength(3);
    expect(rising[0]).toBeLessThan(rising[1]);
    expect(rising[1]).toBeLessThan(rising[2]);
    expect(note("ring")).toHaveLength(4);
    expect(RING_EVERY_MS).toBe(2400);
  });
  it("ringback is two soft 480 Hz pulses every 3 seconds", () => {
    expect(note("ringback").map(n => n.freq)).toEqual([480, 480]);
    expect(RINGBACK_EVERY_MS).toBe(3000);
  });
  it("never goes above 0.12 gain, whatever the volume", () => {
    expect(gainFor(1)).toBeLessThanOrEqual(MAX_GAIN);
    expect(gainFor(5)).toBeLessThanOrEqual(MAX_GAIN);
    expect(gainFor(0)).toBe(0);
    expect(gainFor(0.5)).toBeCloseTo(MAX_GAIN / 2);
    expect(MAX_GAIN).toBe(0.12);
  });
  it("settings default to on at full volume and are remembered", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
    expect(loadSoundSettings(storage)).toEqual({ on: true, volume: 1 });
    saveSoundSettings({ on: false, volume: 0.4 }, storage);
    expect(loadSoundSettings(storage)).toEqual({ on: false, volume: 0.4 });
    store.set("hc.sounds", "garbage");
    expect(loadSoundSettings(storage)).toEqual({ on: true, volume: 1 });
  });
});
