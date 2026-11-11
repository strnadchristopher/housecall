import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChords } from "../../../core/context";
import { copy } from "../../copy";
import { clock } from "../../format";
import { Button, Field } from "../../kit";
import { SessionControls } from "../SessionControls";

function Music({ player }: { player: string }) {
  const chords = useChords();
  const element = useRef<HTMLAudioElement>(null);
  useEffect(() => (element.current ? chords.bindMusic(element.current) : undefined), [player]);
  return <audio ref={element} controls data-testid="dj-media" aria-label={copy.chords.music} />;
}

/** Steve as DJ: search, queue, vote to skip. */
export function StevePanel() {
  const chords = useChords();
  const [query, setQuery] = useState("");
  const { steve, session } = chords;
  const search = (event: FormEvent) => { event.preventDefault(); if (query.trim()) void chords.searchSongs(query.trim()); };
  if (session?.kind !== "music")
    return <div className="hc-stack">{!session && <Button kind="primary" onClick={() => void chords.startMusic()}>{copy.chords.startMusic}</Button>}</div>;
  return (
    <div className="hc-stack" data-testid="screen-dj">
      {steve.player && <Music key={steve.player} player={steve.player} />}
      <SessionControls />
      <Button onClick={() => void chords.voteSkip()} disabled={session.votedSkip || !session.hasMedia}>{session.votedSkip ? copy.chords.voted : copy.chords.voteSkip}</Button>
      <form onSubmit={search}>
        <Field label={copy.chords.songSearch} value={query} onChange={event => setQuery(event.target.value)} required />
      </form>
      <ul className="hc-results">
        {steve.results.map(song => (
          <li key={song.index} className="hc-results__action">
            <span><strong>{song.title}</strong><small>{clock(song.seconds)}</small></span>
            <Button onClick={() => void chords.queueSong(song.index)}>{copy.chords.queueSong}</Button>
          </li>
        ))}
      </ul>
      {session.queue.length > 0 && (
        <section className="hc-stack">
          <h3 className="hc-label">{copy.chords.queue}</h3>
          <ol className="hc-results">
            {session.queue.map(item => <li key={item.id} aria-current={item.current || undefined}><strong>{item.title}</strong><small>{item.requestedBy}</small></li>)}
          </ol>
        </section>
      )}
    </div>
  );
}
