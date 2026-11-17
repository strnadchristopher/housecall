import { SecurityContext } from "../../core/securityContext";
import { useSecurityUI } from "./useSecurityUI";
import { useEffect, type ReactNode } from "react";
import { BackendProvider } from "../../core/context";
import { useHousecall } from "../../hooks/useHousecall";
import { useLegacyChat } from "./chat";
import { useLegacyCall } from "./call";
import { useLegacyChords } from "./chords";
import { useLegacyIdentity, type Updater } from "./identity";
import { useDirectory, type HostEntry, type Hosts } from "./hosts";

/**
 * One connected host on the current backend. Every host stays mounted so its
 * session, events and mention counts keep running; only the active host
 * renders the interface.
 */
export function LegacyHost({ host, hosts, updater, children }: { host: HostEntry; hosts: Hosts; updater: Updater; children: ReactNode }) {
  const c = useHousecall();
  useEffect(() => {
    const clear = (event: Event) => { (event as CustomEvent<Promise<void>[]>).detail.push(c.logout()); };
    window.addEventListener('housecall-clear-sessions', clear);
    return () => window.removeEventListener('housecall-clear-sessions', clear);
  }, [c.logout]);
  const security = useSecurityUI(c, host, hosts);
  const active = hosts.active === host.id;
  const directory = useDirectory(hosts);
  const chat = useLegacyChat(c, host, hosts, directory, active);
  const call = useLegacyCall(c);
  const chords = useLegacyChords(c, call, chat.store.requests, !!chat.store.dmSecurity && !chat.store.dmSecurity.peer.canSendPlaintext);
  const identity = useLegacyIdentity(c, host, hosts, updater, { id: chat.serverId, roles: chat.roles, setRoles: chat.setRoles }, () => { hosts.setActive(host.id); void security.act(() => security.openReceive(true)); });
  // An inactive host renders nothing, so its call has no stage or controls.
  // Leave it rather than keep transmitting the microphone with nothing visible.
  const leaveCall = call.transport.leave;
  const inCall = call.transport.phase !== "idle";
  useEffect(() => { if (!active && inCall) void leaveCall(); }, [active, inCall]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active) { security.close(); chat.store.cancelCompose(); chat.store.discardUpload(); } }, [active]); // Closing a host also closes its camera/link challenges.
  if (!active) return null;
  return <SecurityContext.Provider value={security}><BackendProvider value={{ chat: chat.store, call: call.transport, identity, chords }}>{children}</BackendProvider></SecurityContext.Provider>;
}
