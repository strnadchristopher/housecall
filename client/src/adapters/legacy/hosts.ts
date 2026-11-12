import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ServerEntry } from "../../core/chat";
import { parseServerInput } from "../../data/serverInput";
import { secureSession } from "../../transport/secureSession";

export { parseServerInput };

/** One connected host. The current backend keeps several servers per host. */
export interface HostEntry {
  id: string;
  /** Empty on the web build: the page host is the server. */
  origin: string;
  /** Invite token supplied with "Add Server", if the input was an invite link. */
  token: string;
  /** Added from the picker; removed again if the person backs out before signing in. */
  added: boolean;
  /** A stored session may still reopen this host; the sign-in screen waits for the answer. */
  restoring: boolean;
}

export interface HostReport {
  signedIn: boolean;
  servers: Omit<ServerEntry, "current">[];
}

export function isNative(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Picker rows reported by every mounted host, shared without re-rendering the hosts. */
class Directory {
  private reports = new Map<string, HostReport>();
  private listeners = new Set<() => void>();
  private snapshot: Record<string, HostReport> = {};
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.snapshot;
  private wanted = new Map<string, string>();
  /** Remembers which server to open once another host becomes active. */
  want(hostId: string, serverId: string) {
    this.wanted.set(hostId, serverId);
  }
  take(hostId: string) {
    const serverId = this.wanted.get(hostId);
    this.wanted.delete(hostId);
    return serverId;
  }
  report(hostId: string, report?: HostReport) {
    if (report) this.reports.set(hostId, report);
    else this.reports.delete(hostId);
    this.snapshot = Object.fromEntries(this.reports);
    for (const listener of this.listeners) listener();
  }
}

export function useHosts() {
  const directory = useMemo(() => new Directory(), []);
  const [hosts, setHosts] = useState<HostEntry[]>(() => [
    { id: "host-0", origin: import.meta.env.VITE_API_ORIGIN ?? "", token: "", added: false, restoring: isNative() },
  ]);
  const [active, setActive] = useState("host-0");
  const [previous, setPrevious] = useState("host-0");
  const latest = useRef({ hosts, active, previous });
  latest.current = { hosts, active, previous };
  const add = useCallback((input: string) => {
    const { origin, token } = parseServerInput(input);
    const existing = latest.current.hosts.find(host => host.origin === origin);
    if (existing) {
      setActive(existing.id);
      if (token) setHosts(list => list.map(host => (host.id === existing.id ? { ...host, token } : host)));
      return;
    }
    const id = `host-${crypto.randomUUID()}`;
    setPrevious(latest.current.active);
    setHosts([...latest.current.hosts, { id, origin, token, added: true, restoring: false }]);
    setActive(id);
  }, []);
  const remove = useCallback((id: string) => {
    const next = latest.current.hosts.filter(host => host.id !== id);
    if (!next.length) return;
    directory.report(id);
    setHosts(next);
    if (latest.current.active === id)
      setActive(next.some(host => host.id === latest.current.previous) ? latest.current.previous : next[0].id);
  }, [directory]);
  /** Forget an invite token once it was redeemed or consumed. */
  const clearToken = useCallback((id: string) => {
    setHosts(list => list.map(host => (host.id === id && host.token ? { ...host, token: "" } : host)));
  }, []);
  const finishRestore = useCallback((id: string) => {
    setHosts(list => list.map(host => (host.id === id && host.restoring ? { ...host, restoring: false } : host)));
  }, []);
  // Native cold start: one host per stored session. The most recent one becomes host-0.
  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false;
    void secureSession.list().then(origins => {
      if (cancelled) return;
      setHosts(list => {
        const first = list.find(host => host.id === "host-0");
        const fixed = first?.origin ?? "";
        const rest = origins.filter(origin => origin !== fixed);
        const home = fixed ? undefined : rest.shift();
        const restoreHome = home !== undefined || (!!fixed && origins.includes(fixed));
        return [
          ...list.map(host => (host.id === "host-0" ? { ...host, origin: home ?? host.origin, restoring: restoreHome } : host)),
          ...rest.map(origin => ({ id: `host-${crypto.randomUUID()}`, origin, token: "", added: true, restoring: true })),
        ];
      });
    });
    return () => { cancelled = true; };
  }, []);
  return { hosts, active, setActive, add, remove, clearToken, finishRestore, directory };
}

export type Hosts = ReturnType<typeof useHosts>;

export function useDirectory(hosts: Hosts): Record<string, HostReport> {
  return useSyncExternalStore(hosts.directory.subscribe, hosts.directory.get);
}
