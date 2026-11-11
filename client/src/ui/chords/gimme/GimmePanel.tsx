import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChords } from "../../../core/context";
import { copy } from "../../copy";
import { Button, Field } from "../../kit";
import { SessionControls } from "../SessionControls";

function Film({ player }: { player: string }) {
  const chords = useChords();
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => (element.current ? chords.bindWatch(element.current) : undefined), [player]);
  return <video ref={element} className="hc-film" playsInline data-testid="plex-media" aria-label={copy.chords.film} />;
}

/** Gimme: request a title, and watch from the library with the call when the server has one. */
export function GimmePanel() {
  const chords = useChords();
  const [title, setTitle] = useState("");
  const [tv, setTv] = useState(false);
  const { gimme, session } = chords;
  const watching = session?.kind === "watch";
  const request = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) void chords.request(title.trim(), tv ? "tv" : "movie").then(() => setTitle(""));
  };
  return (
    <div className="hc-stack" data-testid="screen-gimme">
      {gimme.canRequest && (
        <form className="hc-stack" onSubmit={request}>
          <Field label={copy.chords.title} value={title} onChange={event => setTitle(event.target.value)} required />
          <label className="hc-check"><input type="checkbox" checked={tv} onChange={event => setTv(event.target.checked)} /><span>{copy.chords.tv}</span></label>
          <Button kind="primary" type="submit">{copy.chords.request}</Button>
        </form>
      )}
      {gimme.requests.length > 0 && (
        <section className="hc-stack">
          <h3 className="hc-label">{copy.chords.requests}</h3>
          <ul className="hc-results">
            {gimme.requests.map(item => <li key={item.id}><strong>{item.title}</strong><span>{item.status}</span></li>)}
          </ul>
        </section>
      )}
      {gimme.canWatch && (
        <section className="hc-stack">
          <h3 className="hc-label">{copy.chords.watch}</h3>
          {!session && <Button kind="primary" onClick={() => void chords.startWatch()}>{copy.chords.startWatch}</Button>}
          {watching && (
            <>
              {gimme.player && <Film key={gimme.player} player={gimme.player} />}
              {gimme.player && <Button onClick={chords.toggleSubtitles} aria-pressed={gimme.subtitles}>{copy.chords.subtitles}</Button>}
              <SessionControls />
              {session.isHost && <Button onClick={() => void chords.loadLibraries()}>{copy.chords.libraries}</Button>}
              <ul className="hc-results">
                {gimme.libraries.map(library => (
                  <li key={library.id}><button type="button" className="hc-rowbtn" onClick={() => void chords.openLibrary(library.id)}>{library.title}</button></li>
                ))}
              </ul>
              <ul className="hc-results">
                {gimme.items.map(item => (
                  <li key={item.id} className="hc-results__action">
                    <span><strong>{item.title}</strong><small>{item.kind}</small></span>
                    {session.isHost && <Button kind="primary" onClick={() => void chords.watch(item.id)}>{copy.chords.watchNow}</Button>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
