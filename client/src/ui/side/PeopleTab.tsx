import { useCall, useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, IconButton } from "../kit";
import { useNav } from "../shell/nav";

/**
 * Members of the conversation. The current backend reports no presence, so none is drawn.
 * Each other person has a Call button: it opens your direct conversation with them and rings.
 */
export function PeopleTab() {
  const chat = useChat();
  const call = useCall();
  const nav = useNav();
  return (
    <ul className="hc-people" data-testid="people">
      {chat.people.map(person => (
        <li key={person.id}>
          <Avatar name={person.name} src={person.avatarUrl} />
          <span><strong>{person.name}</strong>{person.owner && <small>{copy.side.owner}</small>}</span>
          {call.available && person.id !== chat.me.id && (
            <IconButton icon="phone" label={copy.call.callPerson(person.name)}
              onClick={() => { nav.set({ main: "chat", screen: "main" }); void call.callPerson(person.id); }} />
          )}
        </li>
      ))}
    </ul>
  );
}
