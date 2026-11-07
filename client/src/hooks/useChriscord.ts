import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authenticatePasskey } from "../transport/passkeys";
import { Api, ApiError } from "../transport/api";
import { NotificationReconciler } from "../transport/notifications";
import type { NotificationRecord } from "../transport/notifications";
import { acceptActivity, type ActivitySnapshot } from "../data/activities";
import { TypingStore } from "../state/typing";
import { MessageStore } from "../state/messages";
import type { Message } from "../state/messages";
import type {
  Auth,
  Channel,
  Device,
  Report,
  ServerEvent,
  User,
} from "../data/types";
export function useChriscord() {
  const api = useMemo(() => new Api(), []),
    store = useMemo(() => new MessageStore(), []),
    notifications = useMemo(() => new NotificationReconciler(), []);
  const [auth, setAuth] = useState<Auth>(),
    [channels, setChannels] = useState<Channel[]>([]),
    [members, setMembers] = useState<User[]>([]),
    [channel, setChannel] = useState("");
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
    generation = useRef(0);
  selected.current = channel;
  const logout = useCallback(() => {
    generation.current++;
    api.authenticate();
    setAuth(undefined);
    setMessages([]);
    setChannels([]);
    setMembers([]);
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
  }, [api, store, notifications, typingStore]);
  const refresh = useCallback(
    async (id = selected.current) => {
      const epoch = generation.current;
      const [cs, ms, ns] = await Promise.all([
        api.get<{ channels: Channel[] }>("/api/channels"),
        api.get<{ members: User[] }>("/api/members"),
        api.get<{ notifications: NotificationRecord[] }>("/api/notifications"),
      ]);
      if (epoch !== generation.current) return;
      setChannels(cs.channels);
      setMembers(ms.members);
      setNoticeList(ns.notifications);
      notifications.reconcile(ns.notifications);
      const active = id || cs.channels[0]?.id;
      if (active) {
        if (!selected.current) setChannel(active);
        const result = await api.get<{ messages: Message[] }>(
          `/api/channels/${encodeURIComponent(active)}/messages`,
        );
        if (epoch !== generation.current) return;
        for (const m of result.messages) store.upsert(m);
        if (active === selected.current || !selected.current)
          setMessages(store.list(active));
      }
    },
    [api, store, notifications],
  );
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setError("");
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
        if (e instanceof ApiError && e.status === 401) logout();
      } finally {
        setBusy(false);
      }
    },
    [logout],
  );
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
  ) => {
    const { server_origin, ...credentials } = values;
    api.configure(String(server_origin ?? ""));
    await establish(
      await api.post<Auth>(path, {
        ...credentials,
        device_name: "Chriscord browser",
      }),
    );
  };
  const passkeyLogin = async (username: string, origin: string) => {
    api.configure(origin);
    await establish(await authenticatePasskey(api, username));
  };
  useEffect(() => {
    if (!auth) return;
    let stop = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.get<{ events: ServerEvent[]; cursor: number }>(
          `/api/events?after=${cursor.current}`,
          abort.signal,
        );
        if (stop) return;
        for (const e of result.events) {
          typingStore.apply(e);
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
          logout();
          setError("This device session was revoked. Sign in again.");
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
  }, [auth, api, store, notifications, refresh, logout, typingStore]);
  const select = async (id: string) => {
    selected.current = id;
    setChannel(id);
    setMessages([]);
    await refresh(id);
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
    channel,
    messages,
    devices,
    reports,
    noticeList,
    error,
    busy,
    online,
    capabilities,
    run,
    authenticate,
    passkeyLogin,
    logout,
    refresh,
    select,
    loadDevices,
    loadReports,
    store,
    notifications,
    setMessages,
  };
}
