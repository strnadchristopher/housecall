import { useEffect, useState } from "react";
import { useCall, useChat } from "../../core/context";
import { ChannelHeader } from "../chat/ChannelHeader";
import { MessageList } from "../chat/MessageList";
import { CallBar } from "../chat/CallBar";
import { Composer } from "../chat/Composer";
import { CallStage } from "../call/CallStage";
import { DmView } from "../dm/DmView";
import { RightPanel } from "../side/RightPanel";
import { SettingsView } from "../settings/SettingsView";
import { copy } from "../copy";
import { ErrorLine, cx } from "../kit";
import { usePhone } from "../tokens/motion";
import { ServerPicker } from "./ServerPicker";
import { ChannelList } from "./ChannelList";
import { CallDock } from "./CallDock";
import { UserBar } from "./UserBar";
import { NavContext, type Nav } from "./nav";

/**
 * Three columns on desktop; one column with stack navigation on a phone
 * (list, then conversation, with the right column as a sheet).
 */
export function AppShell() {
  const chat = useChat();
  const call = useCall();
  const phone = usePhone();
  const [nav, setNav] = useState<Nav>({ left: "channels", main: "chat", section: "account", side: { kind: "tabs", tab: "people" }, screen: "list", sheet: false });
  const set = (next: Partial<Nav>) => setNav(current => ({ ...current, ...next }));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setNav(current => current.sheet ? { ...current, sheet: false } : current.main === "settings" ? { ...current, main: "chat" } : current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <NavContext.Provider value={{ ...nav, set }}>
      <div className={cx("hc-shell", phone && "is-phone")} data-screen={nav.screen} data-sheet={nav.sheet ? "" : undefined}>
        <nav className="hc-left" aria-label={copy.app.name} inert={phone && nav.screen !== "list"}>
          <ServerPicker />
          {nav.left === "dm" ? <DmView /> : <ChannelList />}
          <CallDock />
          <UserBar />
        </nav>
        <main className="hc-center" inert={phone && nav.screen !== "main"}>
          {nav.main === "settings" ? <><CallStage away /><SettingsView /></> : (
            <>
              <ChannelHeader />
              {!chat.online && <p className="hc-offline" role="status">{copy.state.reconnecting}</p>}
              <CallStage />
              <MessageList />
              <ErrorLine text={chat.error} onDismiss={chat.clearError} dismissLabel={copy.common.dismiss} />
              {call.available && <CallBar />}
              <Composer />
            </>
          )}
        </main>
        {nav.main === "chat" && (
          <>
            {phone && nav.sheet && <button type="button" className="hc-scrim" aria-label={copy.common.close} onClick={() => set({ sheet: false })} />}
            <aside className="hc-right" aria-label={copy.side.people} inert={phone && !nav.sheet}>
              <RightPanel />
            </aside>
          </>
        )}
      </div>
    </NavContext.Provider>
  );
}
