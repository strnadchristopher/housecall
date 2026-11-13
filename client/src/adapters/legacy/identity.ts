import { useEffect, useRef, useState } from "react";
import type { AccessRequestRecord, IdentityProvider, InviteResult, RequestStatus, SetupRow, UpdateState } from "../../core/identity";
import { decodeInviteCode, encodeInviteCode } from "../../data/inviteCode";
import { deviceName } from "../../hooks/useHousecall";
import { ApiError } from "../../transport/api";
import { publicJson } from "../../transport/publicApi";
import { addPending, readPending, removePending } from "../../state/pendingRequests";
import type { Role } from "../../data/types";
import { subscribeInviteLinks } from "../../transport/deepLinks";
import { clearNativePush, enableNativePush, nativePushStatus, type NativePushStatus } from "../../transport/nativePush";
import { iconPath } from "../../data/people";
import { reportScreenshot, submitReport } from "../../transport/reports";
import { currentUser, person, hostLabel, type Housecall } from "./chat";
import { isNative, parseServerInput, type HostEntry, type Hosts } from "./hosts";
import { forgetAccount, lastConversation, readAccounts, remember } from "../../state/remembered";

export interface Updater {
  state?: UpdateState;
  restart(): Promise<void>;
  dismiss(): void;
}

function initialInvite(): string {
  return new URLSearchParams(location.hash.slice(1)).get("invite") ?? new URLSearchParams(location.search).get("invite") ?? "";
}

/** IdentityProvider over the current password sessions. Sessions live in memory, one per host. */
export function useLegacyIdentity(
  c: Housecall, host: HostEntry, hosts: Hosts, updater: Updater,
  server: { id: string; roles: Role[]; setRoles: (roles: Role[]) => void },
): IdentityProvider {
  const [inviteToken, setInviteToken] = useState(() => host.added ? host.token : initialInvite());
  const [address, setAddress] = useState(host.origin);
  const [push, setPush] = useState<NativePushStatus>();
  const [, bump] = useState(0);
  const signedIn = useRef(false);
  signedIn.current = !!c.auth;

  useEffect(() => {
    let cancelled = false;
    void nativePushStatus().then(status => { if (!cancelled) setPush(status); }).catch(() => {});
    return () => { cancelled = true; };
  }, [c.auth?.user.id]);

  const hostOrigin = host.origin || location.origin;
  const consuming = useRef(false);
  const [joinOffer, setJoinOffer] = useState<{ origin: string; token: string }>();
  const [pendingVersion, setPendingVersion] = useState(0);
  const [requestStatus, setRequestStatus] = useState<Record<string, RequestStatus>>({});
  const [accessCount, setAccessCount] = useState(0);
  const [accessOpen, setAccessOpen] = useState(true);
  const checked = useRef<Record<string, string>>({});

  /** Join the invite's server. Same host: redeem now. Another host: connect it (its invite token waits for sign-in). */
  const redeem = (token: string) => c.run(async () => {
    const result = await c.api.post<{ server_id: string; joined: boolean }>("/api/invites/redeem", { token });
    // Only a new membership changes the server list, which is what makes the chat adapter open it. The wish has
    // to be registered before the refresh: the adapter checks for it when the longer list renders.
    if (result.joined) hosts.directory.want(host.id, result.server_id);
    await c.refresh();
  });
  const redeemOrAdd = (origin: string, token: string) => {
    if (origin === hostOrigin) void redeem(token);
    else hosts.add(encodeInviteCode(origin, token));
  };

  // Links from outside never join silently: signed in they wait for confirmJoin(); signed out they prefill.
  useEffect(() => {
    if (host.added) return;
    return subscribeInviteLinks(invite => {
      if (signedIn.current) { setJoinOffer({ origin: invite.server_origin, token: invite.token }); return; }
      setAddress(invite.server_origin);
      setInviteToken(invite.token);
    }, error => void c.run(async () => { throw error; }));
  }, [c.run, host.added]); // eslint-disable-line react-hooks/exhaustive-deps

  // A code for this already-connected host arrived through hosts.add: redeem it once signed in.
  useEffect(() => {
    if (!c.auth || !host.token || consuming.current) return;
    const token = host.token;
    hosts.clearToken(host.id);
    void redeem(token);
  }, [c.auth, host.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native cold start: reopen the session kept in secure storage, then open the last chat.
  const restoreStarted = useRef("");
  useEffect(() => {
    if (!isNative() || !host.restoring || !host.origin || restoreStarted.current === host.origin) return;
    restoreStarted.current = host.origin;
    const origin = host.origin;
    void c.restore(origin, name => lastConversation(origin, name)).then(result => {
      if (result === "ok") { if (c.auth) remember({ origin, username: c.auth.user.username }); hosts.finishRestore(host.id); }
      else if (host.added) hosts.remove(host.id);
      else hosts.finishRestore(host.id);
    });
  }, [host.restoring, host.origin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (host.origin) setAddress(host.origin); }, [host.origin]);

  // Owner: how many access requests wait, and whether requests are open.
  const loadAccess = async () => {
    const [list, instance] = await Promise.all([
      c.api.get<{ requests: { id: string; username: string; message: string; status: RequestStatus; created_at: number }[] }>("/api/access-requests"),
      c.api.get<{ requests_open: boolean }>("/api/instance"),
    ]);
    setAccessCount(list.requests.filter(r => r.status === "pending").length);
    setAccessOpen(instance.requests_open);
    return list.requests.map((r): AccessRequestRecord => ({ id: r.id, username: r.username, message: r.message, status: r.status, createdAt: r.created_at }));
  };
  useEffect(() => {
    if (!c.auth?.user.is_owner) { setAccessCount(0); return; }
    let stop = false;
    const tick = () => { void loadAccess().catch(() => {}); };
    tick();
    const timer = setInterval(() => { if (!stop) tick(); }, 60_000);
    return () => { stop = true; clearInterval(timer); };
  }, [c.auth?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Remember which chat is open, so the next sign-in reopens it.
  useEffect(() => {
    if (c.auth && c.channel) remember({ origin: hostOrigin, username: c.auth.user.username, lastConversationId: c.channel });
  }, [c.auth?.user.username, c.channel, hostOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  const normalized = (origin: string) => { try { return origin ? parseServerInput(origin).origin : ""; } catch { return origin; } };
  const authenticate = (path: string, origin: string, values: Record<string, unknown>) => c.run(async () => {
    const serverOrigin = host.added ? host.origin : normalized(origin);
    const target = serverOrigin || location.origin;
    const name = String(values.username ?? "");
    const pendingToken = path === "/api/login" ? inviteToken : "";
    consuming.current = true;
    try {
      await c.authenticate(path, { server_origin: serverOrigin, ...values }, lastConversation(target, name));
      remember({ origin: target, username: name });
      // An approved access request is spent once its owner has logged in.
      for (const request of readPending()) if (request.origin === target && request.username === name) removePending(request.id);
      setPendingVersion(n => n + 1);
      if (location.hash.includes("invite=") || location.search.includes("invite=")) history.replaceState(null, "", location.pathname);
      setInviteToken("");
      hosts.clearToken(host.id);
      // "I already have an account": the invite carried through log-in is redeemed now.
      if (pendingToken) {
        await c.api.post("/api/invites/redeem", { token: pendingToken });
        await c.refresh();
      }
    } finally {
      consuming.current = false;
    }
  });
  // Re-read after every change (pendingVersion is the re-render trigger).
  const pendingNow = pendingVersion >= 0 ? readPending() : [];
  const origin = () => new URL(c.api.mediaRequest("/api/me").url).origin;
  const loadRoles = async () => { if (server.id) server.setRoles((await c.api.get<{ roles: Role[] }>(`/api/servers/${server.id}/roles`)).roles); };

  return {
    signedIn: !!c.auth, busy: c.busy, error: c.error,
    me: c.auth ? person(currentUser(c) ?? c.auth.user) : undefined,
    owner: !!c.auth?.user.is_owner,
    native: isNative(), address, inviteToken,
    remembered: readAccounts()
      .filter(account => isNative() || account.origin === location.origin)
      .map(({ origin, username }) => ({ origin, username })),
    inviteAppLink: !isNative() && inviteToken && /^[a-f0-9]{64}$/.test(inviteToken)
      ? `housecall://invite?code=${encodeInviteCode(address || location.origin, inviteToken)}` : undefined,
    restoring: host.restoring && !c.auth,
    pendingJoin: joinOffer ? { host: new URL(joinOffer.origin).host } : undefined,
    pendingRequests: pendingNow.map(request => ({ ...request, status: requestStatus[request.id] ?? "pending" })),
    accessRequestsPending: accessCount,
    accessRequestsOpen: accessOpen,
    adding: host.added && !c.auth && !host.restoring,
    serverName: c.servers.find(candidate => candidate.id === server.id)?.name ?? hostLabel(host),
    serverId: server.id,
    serverIconUrl: (() => { const current = c.servers.find(candidate => candidate.id === server.id); return current ? iconPath(current) : undefined; })(),
    devices: c.devices.map(device => ({ id: device.id, name: device.device_name, createdAt: device.created_at, current: device.current })),
    notices: c.noticeList.map(notice => ({ id: notice.id, conversation: c.channels.find(channel => channel.id === notice.channel_id)?.name ?? "", at: notice.created_at ?? 0 })),
    roles: server.roles.map(role => ({ id: role.id, name: role.name, memberIds: role.member_ids })),
    reports: c.reports.map(report => ({ id: report.id, kind: report.kind, body: report.body, status: report.status, logs: report.logs ?? undefined, hasScreenshot: !!report.screenshot_id })),
    capabilities: Object.entries(c.capabilities).map(([id, value]) => ({ id, available: value === true })),
    notifications: {
      desktop: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
      background: push?.supported ? (push.enabled ? "on" : "off") : "unsupported",
    },
    update: updater.state,

    clearError: () => void c.run(async () => {}),
    signIn: input => authenticate("/api/login", input.address, { username: input.username, password: input.password }),
    join: input => authenticate("/api/invites/accept", input.address, { token: input.token, username: input.name, password: input.password }),
    setup: input => authenticate("/api/setup", input.address, { setup_token: input.setupToken, username: input.username, password: input.password }),
    signOut: () => c.run(async () => {
      await clearNativePush();
      const current = (await c.api.get<{ devices: { id: string; current: boolean }[] }>("/api/devices")).devices.find(device => device.current);
      if (current) await c.api.delete(`/api/devices/${current.id}`);
      await c.logout();
      if (host.added) hosts.remove(host.id);
    }),
    addServer: input => {
      const parsed = parseServerInput(input);
      if (!isNative()) {
        if (!parsed.token) throw new Error("Paste the invite code the owner sent you.");
        if (parsed.origin !== location.origin) throw new Error("That invite is for another server. Open it in the HouseCall app.");
        if (c.auth) redeemOrAdd(parsed.origin, parsed.token);
        else { setAddress(parsed.origin); setInviteToken(parsed.token); }
        return;
      }
      if (parsed.token && c.auth) redeemOrAdd(parsed.origin, parsed.token);
      else hosts.add(input);
    },
    enterInvite: (input, code) => {
      const parsed = parseServerInput(input);
      const second = code?.trim() ?? "";
      const token = parsed.token || decodeInviteCode(second)?.token || (/^[a-f0-9]{64}$/.test(second) ? second : "");
      if (!token) throw new Error(isNative() ? "That's a server address. Ask its owner for an invite code." : "Paste the invite code the owner sent you.");
      if (!isNative() && parsed.origin !== location.origin) throw new Error("That invite is for another server. Open it in the HouseCall app.");
      if (signedIn.current) { redeemOrAdd(parsed.origin, token); return; }
      setAddress(parsed.origin);
      setInviteToken(token);
    },
    clearInvite: () => setInviteToken(""),
    forgetAccount: (origin, username) => { forgetAccount(origin, username); setPendingVersion(n => n + 1); },
    confirmJoin: () => {
      const offer = joinOffer;
      setJoinOffer(undefined);
      if (offer) redeemOrAdd(offer.origin, offer.token);
    },
    dismissJoin: () => setJoinOffer(undefined),
    checkServer: async address => {
      const { origin } = parseServerInput(address);
      if (!isNative() && origin !== location.origin) throw new Error("This app can only join the server it was opened from.");
      let info: { name?: unknown; requests_open?: unknown };
      try { info = await publicJson<typeof info>(origin, "/api/instance"); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error("That doesn't look like a HouseCall server.");
        throw error;
      }
      if (typeof info.name !== "string" || typeof info.requests_open !== "boolean") throw new Error("That doesn't look like a HouseCall server.");
      checked.current[origin] = info.name;
      return { origin, name: info.name, requestsOpen: info.requests_open };
    },
    preflight: async address => {
      try {
        const { origin } = parseServerInput(address || location.origin);
        if (!isNative() && origin !== location.origin) return undefined;
        const response = await fetch(origin + "/api/preflight", { credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return undefined;
        const data = (await response.json()) as Record<string, { ok?: unknown; reason?: unknown }>;
        const pick = (key: string) => ({ ok: data[key]?.ok === true, reason: typeof data[key]?.reason === "string" ? data[key].reason as string : undefined });
        return { https: pick("https"), call_port: pick("call_port"), storage: pick("storage") };
      } catch { return undefined; }
    },
    requestAccess: input => c.attempt(async () => {
      const origin = parseServerInput(input.origin).origin;
      if (!isNative() && origin !== location.origin) throw new Error("This app can only join the server it was opened from.");
      const sent = await publicJson<{ id: string }>(origin, "/api/access-requests", {
        username: input.username, password: input.password, device_name: deviceName(), message: input.message?.trim() || undefined,
      });
      addPending({ origin, id: sent.id, username: input.username, serverName: checked.current[origin] ?? new URL(origin).host });
      setPendingVersion(n => n + 1);
    }),
    refreshPending: async () => {
      const next: Record<string, RequestStatus> = {};
      await Promise.all(readPending().map(async request => {
        try {
          const { status } = await publicJson<{ status: RequestStatus }>(request.origin, `/api/access-requests/${request.id}/status`);
          next[request.id] = status;
        } catch (error) {
          // The server forgot it (404): nothing more to wait for. Network trouble keeps the last answer.
          if (error instanceof ApiError && error.status === 404) next[request.id] = "declined";
        }
      }));
      setRequestStatus(previous => ({ ...previous, ...next }));
    },
    dismissPending: id => { removePending(id); setPendingVersion(n => n + 1); },
    loadInvites: async () => {
      const { invites } = await c.api.get<{ invites: { id: string; uses: number; max_uses: number | null; expires_at: number | null; used_at: number | null; server_id: string }[] }>("/api/invites");
      return invites.filter(invite => invite.server_id === server.id)
        .map(invite => ({ id: invite.id, uses: invite.uses, maxUses: invite.max_uses, expiresAt: invite.expires_at, usedAt: invite.used_at, serverId: invite.server_id }));
    },
    revokeInvite: id => c.run(async () => { await c.api.delete(`/api/invites/${encodeURIComponent(id)}`); }),
    loadAccessRequests: async () => loadAccess(),
    approveAccessRequest: id => c.run(async () => { await c.api.post(`/api/access-requests/${encodeURIComponent(id)}/approve`, {}); await loadAccess(); }),
    declineAccessRequest: id => c.run(async () => { await c.api.post(`/api/access-requests/${encodeURIComponent(id)}/decline`, {}); await loadAccess(); }),
    setAccessRequestsOpen: open => c.attempt(async () => { await c.api.patch("/api/instance", { requests_open: open }); setAccessOpen(open); }),
    cancelAdd: () => hosts.remove(host.id),
    loadDevices: () => c.run(c.loadDevices),
    revokeDevice: id => c.run(async () => {
      const current = c.devices.find(device => device.id === id)?.current;
      if (current) await clearNativePush();
      await c.api.delete(`/api/devices/${id}`);
      if (current) { await c.logout(); if (host.added) hosts.remove(host.id); } else await c.loadDevices();
    }),
    enableNotifications: () => c.run(async () => {
      const status = await nativePushStatus();
      if (status.supported) {
        if (!c.auth) throw new Error("Sign in before enabling background notifications");
        if (!status.configured) throw new Error("Background notifications are unavailable in this app build");
        await enableNativePush(origin(), c.auth);
        setPush(await nativePushStatus());
      } else if ("Notification" in window) { await Notification.requestPermission(); bump(n => n + 1); }
    }),
    disableBackgroundNotifications: () => c.run(async () => { await clearNativePush(); setPush(await nativePushStatus()); }),
    loadSetupStatus: async () => (await c.api.get<{ integrations: SetupRow[] }>("/api/setup/status")).integrations,
    createInvite: async input => {
      let result: InviteResult = {};
      await c.run(async () => {
        const issued = await c.api.post<{ link?: string; code?: string | null }>("/api/invites", {
          expires_in_seconds: input.expiresInSeconds, max_uses: input.maxUses, server_id: server.id || undefined,
        });
        if (issued.link) result = { link: issued.link, code: issued.code ?? undefined };
      });
      return result;
    },
    loadRoles: () => c.run(loadRoles),
    createRole: name => c.attempt(async () => { await c.api.post(`/api/servers/${server.id}/roles`, { name }); await loadRoles(); }),
    assignRole: (roleId, personId) => c.run(async () => { await c.api.post(`/api/roles/${roleId}/members`, { user_id: personId }); await loadRoles(); }),
    deleteRole: roleId => c.run(async () => { await c.api.delete(`/api/roles/${roleId}`); await loadRoles(); }),
    setDisplayName: name => c.attempt(async () => { await c.api.patch("/api/me", { display_name: name }); await c.refresh(); }),
    setProfile: (name, bio) => c.attempt(async () => { await c.api.patch("/api/me", { display_name: name, bio }); await c.refresh(); }),
    serverVersion: async () => { try { const health = await c.api.get<{ version?: string }>("/api/health"); return health.version; } catch { return undefined; } },
    setAvatar: image => c.attempt(async () => {
      if (image) await c.api.putBlob("/api/me/avatar", image); else await c.api.delete("/api/me/avatar");
      await c.refresh();
    }),
    renameServer: name => c.attempt(async () => { await c.api.patch(`/api/servers/${encodeURIComponent(server.id)}`, { name }); await c.refresh(); }),
    setServerIcon: image => c.attempt(async () => {
      const path = `/api/servers/${encodeURIComponent(server.id)}/icon`;
      if (image) await c.api.putBlob(path, image); else await c.api.delete(path);
      await c.refresh();
    }),
    submitReport: input => c.attempt(async () => { await submitReport(c.api, c.channel, input); }),
    loadReports: () => c.run(c.loadReports),
    resolveReport: id => c.run(async () => { await c.api.patch(`/api/reports/${id}`, { status: "resolved" }); await c.loadReports(); }),
    downloadReportScreenshot: id => c.run(async () => {
      const blob = await reportScreenshot(c.api, id, AbortSignal.timeout(30000));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-screenshot.${blob.type === "image/png" ? "png" : blob.type === "image/jpeg" ? "jpg" : "webp"}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
    restartToUpdate: updater.restart,
    dismissUpdate: updater.dismiss,
  };
}
