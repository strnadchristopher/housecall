import { clearNativePush, reconcileNativePush } from "../transport/nativePush";
import type { GimmeRequestStatus } from "../data/gimme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelNativePasskey } from "../transport/passkeys";
import { Api, ApiError } from "../transport/api";
import { NotificationReconciler } from "../transport/notifications";
import type { NotificationRecord } from "../transport/notifications";
import { acceptActivity, type ActivitySnapshot } from "../data/activities";
import { TypingStore } from "../state/typing";
import { initialConversation } from "../state/initialConversation";
import { secureSession } from "../transport/secureSession";
import { loadStoredSession } from "../transport/sessionRestore";
import { CallEvents, toCallEvent } from "../state/callEvents";
import { MessageStore } from "../state/messages";
import type { Message } from "../state/messages";
import type {
  Auth,
  Channel,
  Device,
  Report,
  Server,
  ServerEvent,
  User,
} from "../data/types";
export function deviceName() {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)
    return /android|iphone|ipad/i.test(navigator.userAgent) ? "Housecall mobile" : "Housecall desktop";
  return "Housecall browser";
}
export function useHousecall() {
  const api = useMemo(() => new Api(), []),
    store = useMemo(() => new MessageStore(), []),
    notifications = useMemo(() => new NotificationReconciler(), []),
    callEvents = useMemo(() => new CallEvents(), []);
  const [auth, setAuth] = useState<Auth>(),
    [channels, setChannels] = useState<Channel[]>([]),
    [members, setMembers] = useState<User[]>([]),
    [servers, setServers] = useState<Server[]>([]),
    [channel, setChannel] = useState("");
  const [gimmeRequests, setGimmeRequests] = useState<GimmeRequestStatus[]>([]);
  const [messages, setMessages] = useState<Message[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [reports, setReports] = useState<Report[]>([]),
    [noticeList, setNoticeList] = useState<NotificationRecord[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true),
    [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  const typingStore = useMemo(() => new TypingStore(), []),
    [typers, setTypers] = useState<string[]>([]);
  const [activities, setActivities] = useState<
    Record<string, ActivitySnapshot | undefined>
  >({});
  const cursor = useRef(0),
    selected = useRef(channel),
    preferred = useRef<string | undefined>(undefined),
    /** Origin whose session is in secure storage; removed on logout or any 401. */
    storedOrigin = useRef<string | undefined>(undefined),
    generation = useRef(0);
  selected.current = channel;
  const logout = useCallback(async () => {
    generation.current++;
    const stored = storedOrigin.current;
    storedOrigin.current = undefined;
    if (stored) await secureSession.remove(stored);
    api.authenticate();
    setAuth(undefined);
    setMessages([]);
    setGimmeRequests([]);
    setChannels([]);
    setMembers([]);
    setServers([]);
    setDevices([]);
    setReports([]);
    setNoticeList([]);
    setChannel("");
    setActivities({});
    store.clear();
    typingStore.clear();
    setTypers([]);
    notifications.clear();
    cursor.current = 0;
    // Clear the WebView immediately even if native cleanup fails. A subsequent
    // login must successfully clear the old background grant before replacing it.
    await Promise.all([cancelNativePasskey(), clearNativePush()]);
  }, [api, store, notifications, typingStore]);
  const refresh = useCallback(
    async (id = selected.current) => {
      const epoch = generation.current;
      const [cs, ms, ns, ss] = await Promise.all([
        api.get<{ channels: Channel[] }>("/api/channels"),
        api.get<{ members: User[] }>("/api/members"),
        api.get<{ notifications: NotificationRecord[] }>("/api/notifications"),
        api.get<{ servers: Server[] }>("/api/servers"),
      ]);
      if (epoch !== generation.current) return;
      setChannels(cs.channels);
      setMembers(ms.members);
      setServers(ss.servers);
      setNoticeList(ns.notifications);
      notifications.reconcile(ns.notifications);
      const active = id || initialConversation(cs.channels, ss.servers, preferred.current);
      if (active) {
        if (!selected.current) setChannel(active);
        const [result, requests] = await Promise.all([
          api.get<{ messages: Message[] }>(`/api/channels/${encodeURIComponent(active)}/messages`),
          api.get<{ requests: GimmeRequestStatus[] }>(`/api/channels/${encodeURIComponent(active)}/gimme/requests`),
        ]);
        if (epoch !== generation.current) return;
        for (const m of result.messages) store.upsert(m);
        if (active === selected.current || !selected.current) {
          setMessages(store.list(active));
          setGimmeRequests(requests.requests);
        }
      }
    },
    [api, store, notifications],
  );
  const attempt = useCallback(
    /** Resolves true when `fn` succeeded, so callers navigate or clear forms only then. */
    async (fn: () => Promise<void>): Promise<boolean> => {
      setError("");
      setBusy(true);
      try {
        await fn();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
        if (e instanceof ApiError && e.status === 401) {
          try { await logout(); } catch (cleanup) { setError(String(cleanup)); }
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [logout],
  );
  const run = useCallback(async (fn: () => Promise<void>) => { await attempt(fn); }, [attempt]);
  const establish = async (result: Auth) => {
    generation.current++;
    api.authenticate(result);
    setAuth(result);
    cursor.current = 0;
    const me = await api.get<{ capabilities: Record<string, unknown> }>(
      "/api/me",
    );
    setCapabilities(me.capabilities);
    await refresh();
  };
  const authenticate = async (
    path: string,
    values: Record<string, unknown>,
    prefer?: string,
  ) => {
    preferred.current = prefer;
    await cancelNativePasskey();
    await clearNativePush();
    const { server_origin, ...credentials } = values;
    const origin = String(server_origin ?? "");
    api.configure(origin);
    const result = await api.post<Auth>(path, {
      ...credentials,
      device_name: deviceName(),
    });
    await establish(result);
    // Native builds keep the session in OS secure storage (web: no-op).
    if (origin && (await secureSession.set(origin, { token: result.token, device_key: result.device_key, username: result.user.username, expires_at: result.expires_at })))
      storedOrigin.current = origin;
  };
  /**
   * Reopen a session kept in secure storage. "none": nothing stored; "gone": the server or the
   * clock says it is no longer valid (and it was removed); "offline": could not ask, kept for later.
   */
  const restore = async (origin: string, preferFor?: (username: string) => string | undefined): Promise<"ok" | "none" | "gone" | "offline"> => {
    api.configure(origin);
    const found = await loadStoredSession(origin, async session => {
      api.authenticate(session);
      return (await api.get<{ user: User }>("/api/me")).user;
    });
    if (found.status !== "ok") { api.authenticate(); return found.status; }
    preferred.current = preferFor?.(found.auth.user.username);
    try {
      await establish(found.auth);
    } catch {
      await logout();
      return "offline";
    }
    storedOrigin.current = origin;
    return "ok";
  };
  useEffect(() => {
    if (!auth) return;
    let stop = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.get<{ events: ServerEvent[]; cursor: number; now?: number }>(
          `/api/events?after=${cursor.current}`,
          abort.signal,
        );
        if (stop) return;
        for (const e of result.events) {
          typingStore.apply(e);
          const ring = toCallEvent(e, result.now);
          if (ring) callEvents.emit(ring);
          if (e.kind === "activity.updated" && e.channel_id) {
            const channelId = e.channel_id;
            setActivities((previous) => ({
              ...previous,
              [channelId]: acceptActivity(
                previous[channelId],
                e.payload as unknown as ActivitySnapshot,
              ),
            }));
          }
          if (e.kind === "activity.stopped" && e.channel_id) {
            const channelId = e.channel_id;
            setActivities((previous) => ({
              ...previous,
              [channelId]: undefined,
            }));
          }
          if (e.kind === "message.deleted") {
            const id = String(e.payload.message_id);
            store.retract(id);
            notifications.retract(id);
          }
        }
        if (result.events.some(e => e.kind === "message.deleted" || e.kind === "message.created"))
          void reconcileNativePush().catch(error => setError(String(error)));
        cursor.current = result.cursor;
        setTypers(
          typingStore
            .list(selected.current)
            .filter((id) => id !== auth.user.id),
        );
        setOnline(true);
        if (result.events.length) await refresh();
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 401) {
          try {
            await logout();
            setError("This device session was revoked. Sign in again.");
          } catch (cleanup) { setError(`Session revoked; native notification cleanup failed: ${String(cleanup)}`); }
          return;
        }
        setOnline(false);
      }
      if (!stop) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [auth, api, store, notifications, refresh, logout, typingStore, callEvents]);
  const [loading, setLoading] = useState(false);
  const select = async (id: string) => {
    selected.current = id;
    setChannel(id);
    setMessages([]);
    setGimmeRequests([]);
    setLoading(true);
    try { await refresh(id); } finally { if (selected.current === id) setLoading(false); }
  };
  const loadDevices = async () =>
    setDevices((await api.get<{ devices: Device[] }>("/api/devices")).devices);
  const loadReports = async () =>
    setReports((await api.get<{ reports: Report[] }>("/api/reports")).reports);
  const loadActivity = async () => {
    try {
      const snapshot = await api.get<ActivitySnapshot>(
        `/api/channels/${selected.current}/activity`,
      );
      setActivities((previous) => ({
        ...previous,
        [selected.current]: acceptActivity(
          previous[selected.current],
          snapshot,
        ),
      }));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  };
  return {
    api,
    auth,
    activities,
    loadActivity,
    typers,
    channels,
    members,
    servers,
    channel,
    messages,
    gimmeRequests,
    devices,
    reports,
    noticeList,
    error,
    busy,
    online,
    capabilities,
    run,
    attempt,
    loading,
    authenticate,
    restore,
    prefer: (id?: string) => { preferred.current = id; },
    logout,
    refresh,
    select,
    loadDevices,
    loadReports,
    store,
    notifications,
    callEvents,
    setMessages,
  };
}
