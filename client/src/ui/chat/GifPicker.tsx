import { useEffect, useRef, useState } from "react";
import type { Gif } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Field } from "../kit";

/** A looping clip fetched through the server; nothing loads from the provider directly. */
export function GifClip({ id, title }: { id: string; title: string }) {
  const chat = useChat();
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void chat.gifSource(id).then(url => { if (!cancelled) setSource(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  return source
    ? <video className="hc-gif" src={source} autoPlay loop muted playsInline aria-label={title || copy.messages.gif} />
    : <span className="hc-gif hc-gif--wait" aria-label={copy.common.loading} />;
}

/** Search as you type; choosing a GIF sends it. */
export function GifPicker({ onDone }: { onDone: () => void }) {
  const chat = useChat();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Gif[]>();
  const latest = useRef(0);
  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults(undefined); return; }
    const ticket = ++latest.current;
    const timer = setTimeout(() => void chat.searchGifs(text).then(found => { if (ticket === latest.current) setResults(found); }), 350);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <div className="hc-gifs">
      <Field label={copy.composer.gifSearch} hideLabel placeholder={copy.composer.gifSearch} value={query} onChange={event => setQuery(event.target.value)} autoFocus inputMode="search" />
      {results && results.length === 0 && <p className="hc-muted">{copy.composer.noGifs}</p>}
      <div className="hc-gifs__grid">
        {results?.map(gif => (
          <button key={gif.id} type="button" aria-label={gif.title || copy.messages.gif} onClick={() => { void chat.sendGif(gif); onDone(); }}>
            <GifClip id={gif.id} title={gif.title} />
          </button>
        ))}
      </div>
      <small className="hc-muted">{copy.composer.gifSource}</small>
    </div>
  );
}
