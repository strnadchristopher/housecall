import { useEffect, useRef, useState } from "react";
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
import { CallDock, CallStrip } from "./CallDock";
import { ConfirmJoin } from "./ConfirmJoin";
import { UserBar } from "./UserBar";
import { useDrawerDrag } from "./drawer";
import { NavContext, isStaged, type Nav } from "./nav";

/**
 * Three columns on desktop. On a phone the conversation owns the screen and the left column is a drawer
 * that slides out from the menu button; the right column is a sheet.
 */
export function AppShell() {
  const chat = useChat();
  const call = useCall();
  const phone = usePhone();
  const sheet = useSheet();
  const [nav, setNav] = useState<Nav>({ left: "channels", main: "chat", section: null, side: { kind: "tabs", tab: "people" }, screen: "main", sheet: false });
  const set = (next: Partial<Nav>) => setNav(current => ({ ...current, ...next }));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setNav(current => current.screen === "list" && phone ? { ...current, screen: "main" }
        : current.sheet ? { ...current, sheet: false } : current.main === "settings" ? { ...current, main: "chat" } : current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phone]);

  // The call stage owns the center while you look at the call's conversation: Chat moves to the right column.
  const staged = isStaged(call, chat.current?.id, nav.main);
  const inCall = call.phase === "live" || call.phase === "connecting";
  useEffect(() => {
    if (staged) setNav(current => ({ ...current, side: { kind: "tabs", tab: "chat" } }));
    else if (!inCall) setNav(current => current.side.kind === "tabs" && current.side.tab === "chat" ? { ...current, side: { kind: "tabs", tab: "people" } } : current);
  }, [staged, inCall, call.conversationId]);

  // Drawer focus: opening it puts focus on where you are; closing it hands focus back to the menu button.
  const shell = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLElement>(null);
  // Switching to the phone layout lands on the conversation, never on a drawer left "open" by the wide layout.
  useEffect(() => { if (phone) setNav(current => current.screen === "list" ? { ...current, screen: "main" } : current); }, [phone]);
  const drawerOpen = phone && nav.screen === "list";
  const wasOpen = useRef(drawerOpen);
  useEffect(() => {
    if (wasOpen.current === drawerOpen) return;
    wasOpen.current = drawerOpen;
    if (!phone) return;
    if (drawerOpen) {
      const here = left.current?.querySelector<HTMLElement>("[aria-current='page']") ?? left.current?.querySelector<HTMLElement>("button");
      here?.focus({ preventScroll: true });
    } else if (!shell.current?.querySelector(".hc-center")?.contains(document.activeElement)) {
      // Closed from the drawer, the scrim or Escape: focus returns to the button that opened it.
      shell.current?.querySelector<HTMLElement>("[data-menu-button]")?.focus({ preventScroll: true });
    }
  }, [drawerOpen]);
  const drag = useDrawerDrag(shell, drawerOpen, () => set({ screen: "main" }));

  return (
    <NavContext.Provider value={{ ...nav, set }}>
      <IncomingCall />
      <ConfirmJoin />
      <div ref={shell} className={cx("hc-shell", phone && "is-phone")} data-screen={nav.screen} data-sheet={nav.sheet ? "" : undefined}>
        <nav ref={left} className="hc-left" aria-label={copy.app.name} inert={phone && !drawerOpen} {...(phone ? drag : {})}>
          <ServerPicker />
          {nav.left === "dm" ? <DmView /> : <ChannelList />}
          <CallDock />
          <UserBar />
        </nav>
        {phone && (
          <Presence show={drawerOpen}>
            <button type="button" className="hc-drawer-scrim hc-anim-fade" aria-label={copy.shell.closeMenu} onClick={() => set({ screen: "main" })} />
          </Presence>
        )}
        <main className="hc-center" inert={drawerOpen}>
          <Presence show={nav.main === "settings"}>
            <div className="hc-settings-layer hc-anim-slide-right"><CallStage away /><SettingsView />{phone && <CallStrip />}</div>
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
              {phone && <CallStrip />}
              {!chat.online && <p className="hc-offline" role="status">{copy.state.reconnecting}</p>}
              <CallStage />
              <MessageList />
              <ErrorLine text={chat.error} onDismiss={chat.clearError} dismissLabel={copy.common.dismiss} />
              {call.available && chat.current?.kind !== "channel" && <CallBar />}
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
