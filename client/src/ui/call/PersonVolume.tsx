import { useEffect, useState, useSyncExternalStore } from "react";
import type { VoiceRoomMember } from "../../core/call";
import { personPrefs, readPrefs, setPersonPrefs, subscribePrefs } from "../../state/audioOutput";
import { copy } from "../copy";
import { Avatar, Button } from "../kit";
import { Sheet } from "../Sheet";

/** In a room you are inside: how loud this person is for you, and mute for me. Only on this device. */
export function PersonVolume({ member, onClose }: { member?: VoiceRoomMember; onClose: () => void }) {
  const [last, setLast] = useState<VoiceRoomMember>();
  useEffect(() => { if (member) setLast(member); }, [member]);
  useSyncExternalStore(subscribePrefs, () => localStorage.getItem("hc.voicePrefs") ?? "", () => "");
  const shown = member ?? last;
  const prefs = shown ? personPrefs(readPrefs(), shown.personId) : { volume: 1, muted: false };
  return (
    <Sheet open={!!member} onClose={onClose} title={shown?.name ?? ""} testId="person-volume"
      actions={shown && <Button kind="text" onClick={() => setPersonPrefs(shown.personId, { muted: !prefs.muted })}>{prefs.muted ? copy.call.unmuteForMe : copy.call.muteForMe}</Button>}>
      {shown && (
        <>
          <div className="hc-preview-pop__who"><Avatar name={shown.name} src={shown.avatarUrl} size="md" />{prefs.muted && <small>{copy.call.mutedForMe}</small>}</div>
          <label className="hc-field">
            <span className="hc-field__label">{copy.call.volumeFor(shown.name)}</span>
            <input type="range" min={0} max={100} value={Math.round(prefs.volume * 100)} aria-label={copy.call.volumeFor(shown.name)}
              onChange={event => setPersonPrefs(shown.personId, { volume: Number(event.target.value) / 100 })} />
          </label>
        </>
      )}
    </Sheet>
  );
}
