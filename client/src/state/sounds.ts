/** Call sounds (PLAN section 4 palette). WebAudio, gain at most 0.12, 5 ms attack. No audio files. */
export type SoundName = "join" | "leave" | "mute" | "unmute" | "deafen" | "undeafen" | "stream" | "ring" | "ringback";
export interface Note { freq: number; start: number; dur: number; type: OscillatorType }

export const MAX_GAIN = 0.12;
export const ATTACK = 0.005;
export const RING_EVERY_MS = 2400;
export const RINGBACK_EVERY_MS = 3000;

const E5 = 659.25, B5 = 987.77;

export function phrase(name: SoundName): Note[] {
  const pair = (a: number, b: number, dur: number, gap: number, type: OscillatorType = "sine"): Note[] => [
    { freq: a, start: 0, dur, type }, { freq: b, start: dur + gap, dur, type },
  ];
  switch (name) {
    case "join": return pair(E5, B5, 0.09, 0, "triangle");
    case "leave": return pair(B5, E5, 0.09, 0, "triangle");
    case "mute": return pair(440, 330, 0.06, 0);
    case "unmute": return pair(330, 440, 0.06, 0);
    case "deafen": return pair(220, 165, 0.06, 0);
    case "undeafen": return pair(165, 220, 0.06, 0);
    case "stream": return [E5, E5 * 1.25, E5 * 1.5].map((freq, index) => ({ freq, start: index * 0.08, dur: 0.08, type: "triangle" as const }));
    case "ring": return [E5, B5, E5, B5 * 1.12].map((freq, index) => ({ freq, start: index * 0.18, dur: 0.16, type: "sine" as const }));
    case "ringback": return [0, 0.5].map(start => ({ freq: 480, start, dur: 0.4, type: "sine" as const }));
  }
}

export function gainFor(volume: number): number {
  return Math.min(MAX_GAIN, Math.max(0, volume) * MAX_GAIN);
}

export interface SoundSettings { on: boolean; volume: number }
const KEY = "hc.sounds";
const defaults: SoundSettings = { on: true, volume: 1 };

function store(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function loadSoundSettings(storage: Storage | undefined = store()): SoundSettings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return { on: parsed.on !== false, volume: typeof parsed.volume === "number" ? Math.min(1, Math.max(0, parsed.volume)) : 1 };
  } catch { return { ...defaults }; }
}
export function saveSoundSettings(settings: SoundSettings, storage: Storage | undefined = store()) {
  storage?.setItem(KEY, JSON.stringify(settings));
}

let context: AudioContext | undefined;
/** Plays a phrase now. Silent when sounds are off, volume is 0, or the browser has no WebAudio (or has not allowed it yet). */
export function play(name: SoundName, settings: SoundSettings = loadSoundSettings(), sinkId?: string) {
  if (!settings.on || settings.volume <= 0 || typeof AudioContext === "undefined") return;
  try {
    context ??= new AudioContext();
    if (sinkId && "setSinkId" in context) void (context as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {});
    if (context.state === "suspended") void context.resume();
    const base = context.currentTime;
    const peak = gainFor(settings.volume) * (name === "ringback" ? 0.6 : 1);
    for (const n of phrase(name)) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      const t = base + n.start;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + ATTACK);
      gain.gain.linearRampToValueAtTime(0, t + n.dur);
      osc.connect(gain).connect(context.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    }
  } catch { /* a sound is a nicety */ }
}
