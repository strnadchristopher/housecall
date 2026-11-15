import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar } from "../kit";
import { usePersonCard } from "../people/PersonCard";

export function PeopleTab() {
  const chat = useChat();
  const openPerson = usePersonCard();
  return <ul className="hc-people" data-testid="people">
    {chat.people.map(person => <li key={person.id}>
      <button type="button" className="hc-people__open" onClick={event => openPerson({ id: person.id, anchor: event.currentTarget })} aria-label={person.name}>
        <Avatar name={person.name} src={person.avatarUrl} />
        <span><strong>{person.name}{person.owner && <em className="hc-role">{copy.side.owner}</em>}</strong>{person.bio && <small className="hc-muted">{person.bio}</small>}</span>
      </button>
    </li>)}
  </ul>;
}
