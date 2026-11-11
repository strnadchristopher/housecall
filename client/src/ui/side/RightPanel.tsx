import { useChords } from "../../core/context";
import { GimmePanel } from "../chords/gimme/GimmePanel";
import { StevePanel } from "../chords/steve/StevePanel";
import { SharedBrowserPanel } from "../chords/browser/SharedBrowserPanel";
import { copy } from "../copy";
import { ErrorLine, IconButton, cx } from "../kit";
import { useNav } from "../shell/nav";
import { usePhone } from "../tokens/motion";
import { ChordsTab } from "./ChordsTab";
import { PeopleTab } from "./PeopleTab";
import { SearchPanel } from "./SearchPanel";

/** Right column: People and Chords tabs; a Chord, search or pins opens in place. */
export function RightPanel() {
  const nav = useNav();
  const chords = useChords();
  const phone = usePhone();
  const side = nav.side;
  const tabs = () => nav.set({ side: { kind: "tabs", tab: side.kind === "chord" ? "chords" : "people" } });
  const closeSheet = phone && <IconButton icon="close" label={copy.common.close} onClick={() => nav.set({ sheet: false })} />;
  if (side.kind === "tabs")
    return (
      <>
        <div className="hc-tabs" role="tablist">
          {(["people", "chords"] as const).map(tab => (
            <button key={tab} type="button" role="tab" aria-selected={side.tab === tab} className={cx("hc-tab", side.tab === tab && "is-current")}
              onClick={() => nav.set({ side: { kind: "tabs", tab } })}>
              {tab === "people" ? copy.side.people : copy.side.chords}
            </button>
          ))}
          <span className="hc-tabs__end">{closeSheet}</span>
        </div>
        <div className="hc-side__body" role="tabpanel">{side.tab === "people" ? <PeopleTab /> : <ChordsTab />}</div>
      </>
    );
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
          : side.id === "gimme" ? <GimmePanel /> : side.id === "steve" ? <StevePanel /> : <SharedBrowserPanel />}
      </div>
    </>
  );
}
