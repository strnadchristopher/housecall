import { useChat, useChords } from "../../core/context";
import { copy } from "../copy";
import { Icon, type IconName } from "../kit";
import { useNav } from "../shell/nav";

const ICON: Record<string, IconName> = { gimme: "film", steve: "music", browser: "browser" };

/** Only Chords the server reports as configured. Nothing is drawn for the rest. */
export function ChordsTab() {
  const chords = useChords();
  const chat = useChat();
  const disabled = !!chat.dmSecurity && chat.dmSecurity.peer.state !== "NONE";
  const nav = useNav();
  return (
    <ul className="hc-chords" data-testid="chords">
      {chords.chords.map(chord => (
        <li key={chord.id}>
          <button type="button" className="hc-chord" disabled={disabled} title={disabled ? copy.e2e.off.apps : undefined} onClick={() => nav.set({ side: { kind: "chord", id: chord.id } })}>
            <Icon name={ICON[chord.id]} />
            <strong>{copy.chords[chord.id]}</strong>
            {chord.active && <small className="hc-live">{copy.chords.live}</small>}
            <Icon name="right" />
          </button>
        </li>
      ))}
    </ul>
  );
}
