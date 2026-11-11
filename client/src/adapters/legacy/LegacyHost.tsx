import type { ReactNode } from "react";
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
  const active = hosts.active === host.id;
  const directory = useDirectory(hosts);
  const chat = useLegacyChat(c, host, hosts, directory, active);
  const call = useLegacyCall(c);
  const chords = useLegacyChords(c, call, chat.store.requests);
  const identity = useLegacyIdentity(c, host, hosts, updater, { id: chat.serverId, roles: chat.roles, setRoles: chat.setRoles });
  if (!active) return null;
  return <BackendProvider value={{ chat: chat.store, call: call.transport, identity, chords }}>{children}</BackendProvider>;
}
