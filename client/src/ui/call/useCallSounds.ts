import { useEffect, useRef } from "react";
import { useCall, useChat } from "../../core/context";
import { RING_EVERY_MS, RINGBACK_EVERY_MS, play, type SoundName } from "../../state/sounds";
import { isCallKit } from "../../transport/callkit";
import { speakerId } from "../../state/audioOutput";

/** Plays the call palette: join and leave, mute and deafen, a stream starting, the ring and the ringback. */
export function useCallSounds() {
  const call = useCall();
  const chat = useChat();
  const live = call.phase === "live";
  const room = call.conversationId ? call.rooms[call.conversationId] : undefined;
  const me = chat.me.id;
  const previous = useRef<{ live: boolean; ids: Map<string, boolean>; muted: boolean; deafened: boolean }>({ live: false, ids: new Map(), muted: false, deafened: false });
  const beep = (name: SoundName) => play(name, undefined, speakerId());

  useEffect(() => {
    const before = previous.current;
    const ids = new Map((room ?? []).map(member => [member.personId, member.sharing]));
    if (live && !before.live) beep("join");
    else if (!live && before.live) beep("leave");
    else if (live) {
      for (const [id, sharing] of ids) {
        if (id === me) continue;
        if (!before.ids.has(id)) beep("join");
        else if (sharing && !before.ids.get(id)) beep("stream");
      }
      for (const id of before.ids.keys()) if (id !== me && !ids.has(id)) beep("leave");
      if (call.deafened !== before.deafened) beep(call.deafened ? "deafen" : "undeafen");
      else if (call.muted !== before.muted) beep(call.muted ? "mute" : "unmute");
    }
    previous.current = { live, ids, muted: call.muted, deafened: call.deafened };
  }, [live, room, call.muted, call.deafened]); // eslint-disable-line react-hooks/exhaustive-deps

  const ringing = !!call.incoming && !isCallKit();
  useEffect(() => {
    if (!ringing) return;
    beep("ring");
    const timer = setInterval(() => beep("ring"), RING_EVERY_MS);
    return () => clearInterval(timer);
  }, [ringing]); // eslint-disable-line react-hooks/exhaustive-deps

  const ringback = call.outgoing === "ringing";
  useEffect(() => {
    if (!ringback) return;
    beep("ringback");
    const timer = setInterval(() => beep("ringback"), RINGBACK_EVERY_MS);
    return () => clearInterval(timer);
  }, [ringback]); // eslint-disable-line react-hooks/exhaustive-deps
}
