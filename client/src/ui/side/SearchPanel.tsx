import { useEffect, useState, type FormEvent } from "react";
import type { ChatMessage } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { time } from "../format";
import { Field } from "../kit";

/** Search results or pinned messages for the current conversation. */
export function SearchPanel({ pins }: { pins: boolean }) {
  const chat = useChat();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatMessage[]>();
  useEffect(() => {
    setResults(undefined);
    if (pins) void chat.pins().then(setResults);
  }, [pins, chat.current?.id]);
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) void chat.search(query.trim()).then(setResults);
  };
  return (
    <div className="hc-stack" data-testid={pins ? "screen-pins" : "screen-search"}>
      {!pins && (
        <form onSubmit={search}>
          <Field label={copy.side.searchLabel} hideLabel placeholder={copy.side.searchLabel} value={query} onChange={event => setQuery(event.target.value)} autoFocus inputMode="search" />
        </form>
      )}
      {results && results.length === 0 && <p className="hc-muted">{pins ? copy.side.noPins : copy.side.noResults}</p>}
      <ul className="hc-results">
        {results?.map(message => (
          <li key={message.id}>
            <small>{message.authorName} · {time(message.createdAt)}</small>
            <span>{message.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
