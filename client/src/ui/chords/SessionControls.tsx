import { useChat, useChords } from "../../core/context";
import { copy } from "../copy";
import { clock } from "../format";
import { Button, IconButton } from "../kit";

/** Play, pause, position, host and stop for the shared session of this conversation. */
export function SessionControls() {
  const chords = useChords();
  const chat = useChat();
  const session = chords.session;
  if (!session) return null;
  return (
    <div className="hc-session">
      {!chords.inCall && <p className="hc-muted">{copy.chords.joinCallFirst}</p>}
      <div className="hc-session__row">
        <IconButton icon={session.playing ? "pause" : "play"} label={session.playing ? copy.chords.pause : copy.chords.play}
          disabled={!session.hasMedia} onClick={() => void (session.playing ? chords.pause() : chords.play())} />
        {session.durationMs ? (
          <input type="range" aria-label={copy.chords.seek} min={0} max={session.durationMs} defaultValue={session.positionMs} key={Math.round(session.positionMs / 5000)}
            onChange={event => void chords.seek(Number(event.target.value))} />
        ) : <span className="hc-session__fill" />}
        <small>{clock(session.positionMs / 1000)}{session.durationMs ? ` / ${clock(session.durationMs / 1000)}` : ""}</small>
      </div>
      <label className="hc-field">
        <span className="hc-field__label">{copy.chords.host}</span>
        {session.isHost ? (
          <select aria-label={copy.chords.handOff} value={session.hostId} onChange={event => void chords.handOff(event.target.value)}>
            {chat.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        ) : <strong>{session.hostName}</strong>}
      </label>
      {session.isHost && <Button kind="danger" onClick={() => void chords.stop()}>{copy.chords.stop}</Button>}
    </div>
  );
}
