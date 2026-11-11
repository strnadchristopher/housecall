import type { RequestCard } from "../../core/chat";
import { copy } from "../copy";
import { Icon } from "../kit";

/** A Gimme request and its state, shown to everyone in the conversation. */
export function GimmeCard({ request }: { request: RequestCard }) {
  return (
    <li className="hc-gimme" data-testid="gimme-card">
      <Icon name="film" />
      <div>
        <strong>{request.title}</strong>
        <span>{request.status}</span>
        <small>{copy.chords.gimme} · {request.requestedBy}</small>
      </div>
    </li>
  );
}
