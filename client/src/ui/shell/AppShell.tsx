import { useEffect, useState } from "react";
import { useCall, useChat } from "../../core/context";
import { ChannelHeader } from "../chat/ChannelHeader";
import { MessageList } from "../chat/MessageList";
import { CallBar } from "../chat/CallBar";
import { Composer } from "../chat/Composer";
import { CallStage } from "../call/CallStage";
import { IncomingCall } from "../call/IncomingCall";
import { DmView } from "../dm/DmView";
import { RightPanel } from "../side/RightPanel";
import { SettingsView } from "../settings/SettingsView";
import { copy } from "../copy";
import { ErrorLine, Presence, cx } from "../kit";
import { usePhone, useSheet } from "../tokens/motion";
import { ServerPicker } from "./ServerPicker";
import { ChannelList } from "./ChannelList";
import { CallDock } from "./CallDock";
import { UserBar } from "./UserBar";
import { NavContext, isStaged, type Nav } from "./nav";

/**
 * Three columns on desktop; one column with stack navigation on a phone
 * (list, then conversation, with the right column as a sheet).
 */
export function AppShell() {
  const chat = useChat();
  const call = useCall();
  const phone = usePhone();
  const sheet = useSheet();
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

  // The call stage owns the center while you look at the call's conversation: Chat moves to the right column.
  const staged = isStaged(call, chat.current?.id, nav.main);
  const inCall = call.phase === "live" || call.phase === "connecting";
  useEffect(() => {
    if (staged) setNav(current => ({ ...current, side: { kind: "tabs", tab: "chat" } }));
    else if (!inCall) setNav(current => current.side.kind === "tabs" && current.side.tab === "chat" ? { ...current, side: { kind: "tabs", tab: "people" } } : current);
  }, [staged, inCall, call.conversationId]);

  return (
    <NavContext.Provider value={{ ...nav, set }}>
      <IncomingCall />
      <div className={cx("hc-shell", phone && "is-phone")} data-screen={nav.screen} data-sheet={nav.sheet ? "" : undefined}>
        <nav className="hc-left" aria-label={copy.app.name} inert={phone && nav.screen !== "list"}>
          <ServerPicker />
          {nav.left === "dm" ? <DmView /> : <ChannelList />}
          {/* The stage and its call bar carry the controls while it owns the center. */}
          {!staged && <CallDock />}
          <UserBar />
        </nav>
        <main className="hc-center" inert={phone && nav.screen !== "main"}>
          <Presence show={nav.main === "settings"}>
            <div className="hc-settings-layer hc-anim-slide-right"><CallStage away /><SettingsView />{phone && <CallDock />}</div>
          </Presence>
          {nav.main === "settings" ? null : staged ? (
            <>
              <ChannelHeader />
              {!chat.online && <p className="hc-offline" role="status">{copy.state.reconnecting}</p>}
              <CallStage full />
              <ErrorLine text={chat.error} onDismiss={chat.clearError} dismissLabel={copy.common.dismiss} />
              <CallBar />
            </>
          ) : (
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
            <Presence show={sheet && nav.sheet}>
              <button type="button" className="hc-scrim hc-anim-fade" aria-label={copy.common.close} onClick={() => set({ sheet: false })} />
            </Presence>
            <aside className="hc-right" aria-label={copy.side.label} inert={sheet && !nav.sheet}>
              <RightPanel />
            </aside>
          </>
        )}
      </div>
    </NavContext.Provider>
  );
}
