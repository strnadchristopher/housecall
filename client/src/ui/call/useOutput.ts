import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { personPrefs, readPrefs, speakerId, subscribePrefs } from "../../state/audioOutput";

/** Applies this person's volume and "mute for me", and the chosen speaker, to a playing element. Returns whether they are muted for you. */
export function useOutput(element: RefObject<HTMLMediaElement | null>, personId: string | undefined): boolean {
  const raw = useSyncExternalStore(subscribePrefs, () => (localStorage.getItem("hc.voicePrefs") ?? "") + "|" + (localStorage.getItem("hc.speaker") ?? ""), () => "");
  const prefs = personId ? personPrefs(readPrefs(), personId) : { volume: 1, muted: false };
  useEffect(() => {
    const node = element.current;
    if (node) node.volume = prefs.volume;
  }, [raw, prefs.volume, element]);
  useEffect(() => {
    const node = element.current as (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    const id = speakerId();
    if (node?.setSinkId && id) void node.setSinkId(id).catch(() => {});
  }, [element, raw]);
  return prefs.muted;
}
