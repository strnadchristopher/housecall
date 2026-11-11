import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";

/**
 * The call conversation's chat, in the right column. The Chat tab exists only
 * while the stage shows the call's own conversation, so the selected
 * conversation is the call's: history and composer need no extra wiring.
 */
export function ChatTab() {
  return (
    <>
      <MessageList compact />
      <Composer compact />
    </>
  );
}
