import { useCall, useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, cx } from "../kit";
import { useNav } from "./nav";

/** Flat list of the server's channels. A channel with this client's live call shows who is in it. */
export function ChannelList() {
  const chat = useChat();
  const call = useCall();
  const nav = useNav();
  const channels = chat.conversations.filter(conversation => conversation.kind === "channel");
  return (
    <section className="hc-channels" aria-labelledby="hc-channels-label">
      <h2 id="hc-channels-label" className="hc-label">{copy.channels.label}</h2>
      <ul>
        {channels.map(channel => {
          const here = channel.id === chat.current?.id;
          const mine = call.phase === "live" && call.conversationId === channel.id;
          const inCall = mine ? call.participants.map(p => ({ personId: p.personId, name: p.name })) : call.active[channel.id] ?? [];
          const live = inCall.length > 0;
          return (
            <li key={channel.id}>
              <button type="button" className={cx("hc-channel", here && "is-current", channel.mentions > 0 && "is-unread")}
                aria-current={here ? "page" : undefined} aria-label={copy.channels.open(channel.name)}
                onClick={() => { nav.set({ main: "chat", screen: "main" }); if (!here) void chat.open(channel.id); }}>
                <span className="hc-channel__name">{channel.name}</span>
                {channel.mentions > 0 && <span className="hc-count" aria-label={copy.channels.mentions(channel.mentions)}>{channel.mentions}</span>}
              </button>
              {live && (
                <div className="hc-channel__call" data-testid="channel-call" role="group" aria-label={copy.channels.inCall}>
                  {inCall.slice(0, 6).map(participant => (
                    <span key={participant.personId} title={participant.name}><Avatar name={participant.name} size="sm" /></span>
                  ))}
                  {inCall.length > 6 && <span className="hc-channel__more">+{inCall.length - 6}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
