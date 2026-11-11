import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar } from "../kit";

/** Members of the conversation. The current backend reports no presence, so none is drawn. */
export function PeopleTab() {
  const chat = useChat();
  return (
    <ul className="hc-people" data-testid="people">
      {chat.people.map(person => (
        <li key={person.id}>
          <Avatar name={person.name} />
          <span><strong>{person.name}</strong>{person.owner && <small>{copy.side.owner}</small>}</span>
        </li>
      ))}
    </ul>
  );
}
