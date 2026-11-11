import { useState } from "react";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, Button, Field, Icon, cx } from "../kit";
import { useNav } from "../shell/nav";

/** Pick one person for a direct message, or several for a group. */
export function FriendList() {
  const chat = useChat();
  const nav = useNav();
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const others = chat.friends.filter(person => person.id !== chat.me.id);
  const start = () => {
    void chat.startDirect(picked, name).then(ok => { if (!ok) return; setPicked([]); setName(""); nav.set({ main: "chat", screen: "main" }); });
  };
  return (
    <div className="hc-friends">
      <h3 className="hc-label">{copy.dm.start}</h3>
      <ul>
        {others.map(person => {
          const on = picked.includes(person.id);
          return (
            <li key={person.id}>
              <button type="button" role="checkbox" aria-checked={on} aria-label={`${copy.common.add} ${person.name}`} className={cx("hc-channel", on && "is-picked")}
                onClick={() => setPicked(on ? picked.filter(id => id !== person.id) : [...picked, person.id])}>
                <Avatar name={person.name} size="sm" />
                <span className="hc-channel__name">{person.name}</span>
                {on && <Icon name="check" />}
              </button>
            </li>
          );
        })}
      </ul>
      {picked.length > 0 && (
        <div className="hc-stack hc-friends__go">
          <Field label={copy.dm.name} value={name} onChange={event => setName(event.target.value)} />
          <Button kind="primary" onClick={start} busy={chat.busy}>{copy.dm.create}</Button>
        </div>
      )}
    </div>
  );
}
