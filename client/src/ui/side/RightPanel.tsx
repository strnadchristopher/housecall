import type { KeyboardEvent } from "react";
import { useCall, useChat, useChords } from "../../core/context";
import { ChatTab } from "./ChatTab";
import { GimmePanel } from "../chords/gimme/GimmePanel";
import { StevePanel } from "../chords/steve/StevePanel";
import { SharedBrowserPanel } from "../chords/browser/SharedBrowserPanel";
import { copy } from "../copy";
import { ErrorLine, IconButton, cx } from "../kit";
import { isStaged, sideTabs, useNav } from "../shell/nav";
import { useSheet } from "../tokens/motion";
import { ChordsTab } from "./ChordsTab";
import { PeopleTab } from "./PeopleTab";
import { SearchPanel } from "./SearchPanel";

/** Right column: People and Chords tabs; a Chord, search or pins opens in place. */
export function RightPanel() {
  const nav = useNav();
  const chords = useChords();
  const sheet = useSheet();
  const call = useCall();
  const chat = useChat();
  const staged = isStaged(call, chat.current?.id, nav.main);
  const side = nav.side;
  const tabs = () => nav.set({ side: { kind: "tabs", tab: side.kind === "chord" && chords.chords.length ? "chords" : staged ? "chat" : "people" } });
  const closeSheet = sheet && <IconButton icon="close" label={copy.common.close} onClick={() => nav.set({ sheet: false })} />;
  if (side.kind === "tabs") {
    // The Chords tab exists only when the server reports a configured Chord.
    // The Chat tab exists only while the call stage owns the center.
    const available = sideTabs(staged, chords.chords.length > 0);
    const current = available.find(tab => tab === side.tab) ?? "people";
    const move = (event: KeyboardEvent<HTMLButtonElement>) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -available.length : event.key === "End" ? available.length : 0;
      if (!step) return;
      event.preventDefault();
      const index = Math.abs(step) >= available.length ? (step > 0 ? available.length - 1 : 0) : (available.indexOf(current) + step + available.length) % available.length;
      nav.set({ side: { kind: "tabs", tab: available[index] } });
      requestAnimationFrame(() => document.getElementById(`hc-tab-${available[index]}`)?.focus());
    };
    return (
      <>
        {available.length > 1 ? (
          <div className="hc-tabs" role="tablist" aria-label={copy.side.label}>
            {available.map(tab => (
              <button key={tab} type="button" role="tab" id={`hc-tab-${tab}`} aria-selected={current === tab} aria-controls="hc-tabpanel" tabIndex={current === tab ? 0 : -1}
                className={cx("hc-tab", current === tab && "is-current")} onClick={() => nav.set({ side: { kind: "tabs", tab } })} onKeyDown={move}>
                {copy.side[tab]}
              </button>
            ))}
            <span className="hc-tabs__end">{closeSheet}</span>
          </div>
        ) : (
          <div className="hc-side__head"><h2 id="hc-tab-people">{copy.side.people}</h2><span className="hc-tabs__end">{closeSheet}</span></div>
        )}
        <div className={cx("hc-side__body", current === "chat" && "hc-side__body--chat")} id="hc-tabpanel" role={available.length > 1 ? "tabpanel" : undefined} aria-labelledby={`hc-tab-${current}`}>
          {current === "chat" ? <ChatTab /> : current === "people" ? <PeopleTab /> : <ChordsTab />}
        </div>
      </>
    );
  }
  const title = side.kind === "search" ? copy.side.search : side.kind === "pins" ? copy.side.pins : copy.chords[side.id];
  return (
    <>
      <div className="hc-side__head">
        <IconButton icon="back" label={copy.common.back} onClick={tabs} />
        <h2>{title}</h2>
        <span className="hc-tabs__end">{closeSheet}</span>
      </div>
      <div className="hc-side__body">
        {side.kind === "chord" && <ErrorLine text={chords.error} />}
        {side.kind === "search" || side.kind === "pins" ? <SearchPanel key={side.kind} pins={side.kind === "pins"} />
          : chat.dmSecurity && chat.dmSecurity.peer.state !== "NONE" ? <p className="hc-note">{copy.e2e.off.apps}</p> : side.id === "gimme" ? <GimmePanel /> : side.id === "steve" ? <StevePanel /> : <SharedBrowserPanel />}
      </div>
    </>
  );
}
