import { useEffect, useRef, useState } from "react";
import type { IdentityProvider, InviteResult, SetupRow, UpdateState } from "../../core/identity";
import type { Role } from "../../data/types";
import { subscribeInviteLinks } from "../../transport/deepLinks";
import { clearNativePush, enableNativePush, nativePushStatus, type NativePushStatus } from "../../transport/nativePush";
import { iconPath } from "../../data/people";
import { reportScreenshot, submitReport } from "../../transport/reports";
import { currentUser, person, hostLabel, type Housecall } from "./chat";
import { isNative, type HostEntry, type Hosts } from "./hosts";
import { lastConversation, readAccounts, remember } from "../../state/remembered";

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

  // Invite links prefill only; they never redeem an invite or replace an account.
  useEffect(() => {
    if (host.added) return;
    return subscribeInviteLinks(invite => {
      if (signedIn.current) {
        if (isNative()) hosts.add(`${invite.server_origin}/#invite=${invite.token}`);
        else void c.run(async () => { throw new Error("Sign out before accepting another invitation"); });
        return;
      }
      setAddress(invite.server_origin);
      setInviteToken(invite.token);
    }, error => void c.run(async () => { throw error; }));
  }, [c.run, host.added, hosts.add]);

  const hostOrigin = host.origin || location.origin;
  // Remember which chat is open, so the next sign-in reopens it.
  useEffect(() => {
    if (c.auth && c.channel) remember({ origin: hostOrigin, username: c.auth.user.username, lastConversationId: c.channel });
  }, [c.auth?.user.username, c.channel, hostOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  const authenticate = (path: string, origin: string, values: Record<string, unknown>) => c.run(async () => {
    const target = host.added ? host.origin : origin || location.origin;
    const name = String(values.username ?? "");
    await c.authenticate(path, { server_origin: host.added ? host.origin : origin, ...values }, lastConversation(target, name));
    remember({ origin: target, username: name });
    if (location.hash.includes("invite=") || location.search.includes("invite=")) history.replaceState(null, "", location.pathname);
    setInviteToken("");
  });
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
    adding: host.added && !c.auth,
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
    addServer: input => hosts.add(input),
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
        const issued = await c.api.post<{ link?: string }>("/api/invites", { expires_in_seconds: input.expiresInSeconds, server_id: server.id || undefined });
        if (issued.link) result = { link: issued.link };
      });
      return result;
    },
    loadRoles: () => c.run(loadRoles),
    createRole: name => c.attempt(async () => { await c.api.post(`/api/servers/${server.id}/roles`, { name }); await loadRoles(); }),
    assignRole: (roleId, personId) => c.run(async () => { await c.api.post(`/api/roles/${roleId}/members`, { user_id: personId }); await loadRoles(); }),
    deleteRole: roleId => c.run(async () => { await c.api.delete(`/api/roles/${roleId}`); await loadRoles(); }),
    setDisplayName: name => c.attempt(async () => { await c.api.patch("/api/me", { display_name: name }); await c.refresh(); }),
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
