/** Where call audio goes and how loud each person is for you. Device-local; none of it is a secret. */
export interface PersonPrefs { volume: number; muted: boolean }
export type PrefsMap = Record<string, PersonPrefs>;
const PREFS_KEY = "hc.voicePrefs";
const SPEAKER_KEY = "hc.speaker";

function store(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function clampVolume(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function personPrefs(map: PrefsMap, personId: string): PersonPrefs {
  const found = map[personId];
  return found ? { volume: clampVolume(found.volume), muted: !!found.muted } : { volume: 1, muted: false };
}

export function readPrefs(storage: Storage | undefined = store()): PrefsMap {
  try {
    const parsed = JSON.parse(storage?.getItem(PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PrefsMap : {};
  } catch { return {}; }
}

const listeners = new Set<() => void>();
export function writePrefs(map: PrefsMap, storage: Storage | undefined = store()) {
  storage?.setItem(PREFS_KEY, JSON.stringify(map));
  for (const listener of [...listeners]) listener();
}
export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setPersonPrefs(personId: string, next: Partial<PersonPrefs>) {
  const map = readPrefs();
  writePrefs({ ...map, [personId]: { ...personPrefs(map, personId), ...next } });
}

/** Empty string means the system default. */
export function speakerChoice(storage: Storage | undefined = store()): string {
  return storage?.getItem(SPEAKER_KEY) ?? "";
}
export function speakerId(): string | undefined {
  return speakerChoice() || undefined;
}
export function setSpeaker(id: string) {
  const storage = store();
  if (id) storage?.setItem(SPEAKER_KEY, id); else storage?.removeItem(SPEAKER_KEY);
  for (const listener of [...listeners]) listener();
}

/** Chromium has setSinkId on media elements; Safari and Firefox (mostly) do not, so the picker hides there. */
export function sinkSupported(element: HTMLMediaElement | undefined = typeof document !== "undefined" ? document.createElement("audio") : undefined): boolean {
  return !!element && typeof (element as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function";
}
