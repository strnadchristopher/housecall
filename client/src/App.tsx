import {markdownTokens} from "./data/markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceSession, type VoiceStatus } from "./transport/voice";
import { PlexMedia } from "./data/PlexMedia";
import { MediaTrack } from "./data/MediaTrack";
import { firstPreviewLink, previewLink, type LinkPreview } from "./data/embeds";
import { Screen } from "./ui/Screen";
import type { Intent, ScreenId, ScreenProps } from "./contracts/ui";
import { useChriscord } from "./hooks/useChriscord";
import { registerPasskey } from "./transport/passkeys";
import { ResumableUpload, type Upload } from "./transport/uploads";
import {
  mentionedUsers,
  mentionedRoles,
  roleCandidates,
  completeRole,
  mentionCandidates,
  completeMention,
} from "./data/mentions";
import type { Message } from "./state/messages";
import type { User, Server, Role } from "./data/types";
/** Engineering adapter: data and intents only. Opus owns Screen and all presentation. */
export function App() {
  const c = useChriscord();
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    phase: "idle",
    streams: [],
    receivedBytes: 0,
    decodedFrames: 0,
  });
  const voice = useMemo(() => new VoiceSession(c.api, setVoiceStatus), [c.api]);
  const [muted, setMuted] = useState(false);
  useEffect(() => () => voice.close(), [voice]);
  useEffect(() => {
    if (!c.auth) voice.close();
  }, [c.auth, voice]);
  const initialToken =
    new URLSearchParams(location.hash.slice(1)).get("invite") ??
    new URLSearchParams(location.search).get("invite") ??
    "";
  const [view, setView] = useState<ScreenId>(initialToken ? "invite" : "login"),
    [invite, setInvite] = useState(initialToken),
    [issued, setIssued] = useState(""),
    [reply, setReply] = useState<string | null>(null),
    [editing, setEditing] = useState<Message>(),
    [results, setResults] = useState<Message[]>([]),
    [formEpoch, setFormEpoch] = useState(0);
  const file = useRef<File | undefined>(undefined);
  const [upload, setUpload] = useState<Upload>();
  const uploader = useMemo(
    () => new ResumableUpload(c.api, setUpload),
    [c.api],
  );
  const [draft, setDraft] = useState("");
  const lastTyping = useRef(0);
  const authFields = useRef({
    username: "",
    server_origin: import.meta.env.VITE_API_ORIGIN ?? "",
  });
  const [servers, setServers] = useState<Server[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [serverId, setServerId] = useState("home");
  const [preview, setPreview] = useState<LinkPreview>();
  const [gimmeResult, setGimmeResult] = useState("");
  const [gifs, setGifs] = useState<
    { id: string; title: string; source_url: string }[]
  >([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [plexLibraries, setPlexLibraries] = useState<
    { id: string; title: string; kind: string }[]
  >([]);
  const [plexItems, setPlexItems] = useState<
    {
      id: string;
      title: string;
      kind: string;
      duration_ms: number;
      subtitles: { id: string; language: string }[];
    }[]
  >([]);
  const [plexManifest, setPlexManifest] = useState<string>(),
    [plexError, setPlexError] = useState(""),
    [plexSubtitles, setPlexSubtitles] = useState(false);
  const activity = c.activities[c.channel];
  const plexMediaId =
    activity?.kind === "plex" ? activity.playback.media_id : null;
  useEffect(() => {
    let cancelled = false;
    setPlexManifest(undefined);
    setPlexError("");
    if (
      plexMediaId &&
      voiceStatus.phase === "live" &&
      c.capabilities.plex === true
    )
      void c.api
        .post<{ manifest_url: string }>(
          `/api/channels/${c.channel}/plex/playback`,
          { rating_key: plexMediaId },
        )
        .then((result) => {
          if (!cancelled) setPlexManifest(result.manifest_url);
        })
        .catch((error) => {
          if (!cancelled)
            setPlexError(
              error instanceof Error ? error.message : String(error),
            );
        });
    return () => {
      cancelled = true;
    };
  }, [plexMediaId, voiceStatus.phase, c.channel, c.api, c.capabilities.plex]);
  const channelServer = c.channels.find(
    (channel) => channel.id === c.channel,
  )?.server_id;
  useEffect(() => {
    let cancelled = false;
    if (channelServer) {
      setServerId(channelServer);
      void c.api
        .get<{ roles: Role[] }>(`/api/servers/${channelServer}/roles`)
        .then((result) => {
          if (!cancelled) setRoles(result.roles);
        })
        .catch(() => {});
    } else setRoles([]);
    return () => {
      cancelled = true;
    };
  }, [channelServer, c.api]);
  const userName = (id: string) =>
    c.members.find((m) => m.id === id)?.username ?? id;
  const intent = async (i: Intent) =>
    c.run(async () => {
      const v = i.values,
        id = i.itemId;
      if (i.action === "navigate") {
        return;
      }
      if (!c.auth) {
        if (i.action === "passkey") {
          await c.passkeyLogin(
            authFields.current.username,
            authFields.current.server_origin,
          );
          setView("conversation");
          return;
        }
        if (
          i.action === "setup" ||
          i.action === "login" ||
          i.action === "invite"
        ) {
          setView(i.action);
          return;
        }
        if (i.action === "submit") {
          const path =
            view === "setup"
              ? "/api/setup"
              : view === "invite"
                ? "/api/invites/accept"
                : "/api/login";
          await c.authenticate(path, {
            server_origin: v.server_origin,
            username: String(v.username),
            password: String(v.password),
            setup_token: v.setup_token,
            token: v.token ?? invite,
          });
          history.replaceState(null, "", location.pathname);
          setInvite("");
          setView("conversation");
          return;
        }
      }
      if (i.action === "logout") {
        const ds = await c.api.get<{
          devices: { id: string; current: boolean }[];
        }>("/api/devices");
        const current = ds.devices.find((d) => d.current);
        if (current) await c.api.delete(`/api/devices/${current.id}`);
        c.logout();
        setView("login");
        return;
      }
      if (i.screen === "shell") {
        if (i.action === "select" && id) {
          await c.select(id);
          setView("conversation");
          return;
        }
        if (
          ["servers-admin", "channels-admin", "roles-admin"].includes(i.action)
        ) {
          const data = await c.api.get<{ servers: Server[] }>("/api/servers");
          setServers(data.servers);
          if (i.action === "roles-admin")
            setRoles(
              (
                await c.api.get<{ roles: Role[] }>(
                  `/api/servers/${serverId}/roles`,
                )
              ).roles,
            );
        }
        setView(i.action as ScreenId);
        if (i.action === "devices") await c.loadDevices();
        if (i.action === "reports-admin") await c.loadReports();
        if (i.action === "activities") await c.loadActivity();
        return;
      }
      if (i.action === "back") {
        setView("conversation");
        return;
      }
      if (i.screen === "servers-admin") {
        if (i.action === "select" && id) {
          setServerId(id);
          const server = servers.find((s) => s.id === id);
          if (server) {
            await c.select(server.general_channel_id);
            setView("conversation");
          }
          return;
        }
        await c.api.post("/api/servers", { name: String(v.name) });
        setServers(
          (await c.api.get<{ servers: Server[] }>("/api/servers")).servers,
        );
        await c.refresh();
        return;
      }
      if (i.screen === "channels-admin") {
        await c.api.post("/api/channels", {
          name: String(v.name),
          kind: "channel",
          server_id: String(v.server_id) || serverId,
          member_ids: String(v.member_ids)
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        });
        await c.refresh();
        setView("conversation");
        return;
      }
      if (i.screen === "roles-admin") {
        if (i.action === "delete" && id) await c.api.delete(`/api/roles/${id}`);
        else if (v.user_id && v.role_id)
          await c.api.post(`/api/roles/${v.role_id}/members`, {
            user_id: String(v.user_id),
          });
        else
          await c.api.post(`/api/servers/${serverId}/roles`, {
            name: String(v.name),
          });
        setRoles(
          (await c.api.get<{ roles: Role[] }>(`/api/servers/${serverId}/roles`))
            .roles,
        );
        return;
      }
      if (i.screen === "conversation") {
        if (i.action === "read") {
          const last = c.messages.at(-1);
          if (last) {
            await c.api.post(`/api/channels/${c.channel}/read`, {
              message_id: last.id,
            });
            await c.refresh();
          }
          return;
        }
        const m = c.messages.find((m) => m.id === id);
        if (!m) return;
        if (i.action === "preview-link") {
          const url = firstPreviewLink(m.body);
          if (url) {
            setPreview(await previewLink(c.api, url));
            setView("media");
          }
          return;
        }
        if (i.action === "unsend") {
          await c.api.delete(`/api/messages/${id}`);
          c.store.retract(m.id);
          c.notifications.retract(m.id);
          await c.refresh();
        }
        if (i.action === "reply") setReply(m.id);
        if (i.action === "edit") {
          setEditing(m);
          setDraft(m.body);
          setFormEpoch((n) => n + 1);
        }
        if (i.action === "react")
          await c.api.post(`/api/messages/${id}/reactions`, { emoji: "👍" });
        if (i.action === "pin")
          await c.api.post(`/api/messages/${id}/pin`, { pinned: !m.pinned });
        await c.refresh();
        return;
      }
      if (i.screen === "composer") {
        if (i.action === "mention-role" && id) {
          const role = roles.find((role) => `role-${role.id}` === id);
          if (role) {
            setDraft(completeRole(draft, role.name));
            setFormEpoch((n) => n + 1);
          }
          return;
        }
        if (i.action === "mention" && id) {
          const user = c.members.find((m) => m.id === id);
          if (user) {
            setDraft(completeMention(draft, user.username));
            setFormEpoch((n) => n + 1);
          }
          return;
        }
        if (i.action === "cancel") {
          setReply(null);
          setEditing(undefined);
          setDraft("");
          setFormEpoch((n) => n + 1);
          return;
        }
        const body = String(v.body);
        const latestMembers = await c.api.get<{ members: User[] }>(
          "/api/members",
        );
        const mention_ids = mentionedUsers(body, latestMembers.members);
        const latestRoles = channelServer
          ? (
              await c.api.get<{ roles: Role[] }>(
                `/api/servers/${channelServer}/roles`,
              )
            ).roles
          : [];
        const role_mention_ids = mentionedRoles(body, latestRoles);
        if (editing)
          await c.api.patch(`/api/messages/${editing.id}`, {
            body,
            revision: editing.revision,
          });
        else
          await c.api.post(`/api/channels/${c.channel}/messages`, {
            body,
            reply_to: reply,
            mention_ids,
            role_mention_ids,
            attachment_ids: attachments,
          });
        setReply(null);
        setEditing(undefined);
        setDraft("");
        setAttachments([]);
        setFormEpoch((n) => n + 1);
        await c.api.post(`/api/channels/${c.channel}/typing`, {
          active: false,
        });
        await c.refresh();
        return;
      }
      if (i.screen === "plex") {
        if (i.action === "library" && id)
          setPlexItems(
            (
              await c.api.get<{ items: typeof plexItems }>(
                `/api/channels/${c.channel}/plex/items?section=${encodeURIComponent(id)}&start=0`,
              )
            ).items,
          );
        if (i.action === "choose" && id && activity) {
          const item = plexItems.find((item) => item.id === id);
          if (item) {
            await c.api.post(`/api/channels/${c.channel}/activity/commands`, {
              expected_revision: activity.revision,
              command: {
                type: "select",
                media_id: item.id,
                duration_ms: item.duration_ms,
              },
            });
            await c.loadActivity();
            setView("activities");
          }
        }
        return;
      }
      if (i.screen === "activities") {
        if (i.action === "browse-plex") {
          setPlexLibraries(
            (
              await c.api.get<{ libraries: typeof plexLibraries }>(
                `/api/channels/${c.channel}/plex/sections`,
              )
            ).libraries,
          );
          setPlexItems([]);
          setView("plex");
          return;
        }
        if (i.action === "subtitles") {
          setPlexSubtitles((previous) => !previous);
          return;
        }
        if (i.action === "start") {
          await c.api.post(`/api/channels/${c.channel}/activity`, { kind: id });
        } else if (i.action === "stop") {
          await c.api.delete(`/api/channels/${c.channel}/activity`);
        } else if (activity) {
          await c.api.post(`/api/channels/${c.channel}/activity/commands`, {
            expected_revision: activity.revision,
            command:
              i.action === "submit"
                ? v.command === "select"
                  ? {
                      type: "select",
                      media_id: String(v.media_id),
                      duration_ms: Number(v.duration_ms),
                    }
                  : v.command === "enqueue"
                    ? {
                        type: "enqueue",
                        track: {
                          id: crypto.randomUUID(),
                          title: String(v.title),
                          source: String(v.source),
                          duration_ms: Number(v.duration_ms),
                          requested_by: "",
                        },
                      }
                    : v.command === "handoff"
                      ? { type: "handoff", user_id: String(v.user_id) }
                      : { type: "seek", position_ms: Number(v.position_ms) }
                : { type: i.action },
          });
        }
        await c.loadActivity();
        return;
      }
      if (i.screen === "voice") {
        if (i.action === "join") await voice.join(c.channel, true);
        if (i.action === "leave") await voice.leave();
        if (i.action === "share") await voice.screenShare();
        if (i.action === "mute") {
          voice.mute(!muted);
          setMuted(!muted);
        }
        if (i.action === "submit")
          await voice.setAudio(Number(v.bitrate), !!v.noise_suppression);
        return;
      }
      if (i.screen === "gifs") {
        if (i.action === "choose" && id) {
          const gif = gifs.find((gif) => gif.id === id);
          if (gif) {
            setDraft((previous) => `${previous} ${gif.source_url}`.trim());
            setFormEpoch((n) => n + 1);
            setView("conversation");
          }
          return;
        }
        const result = await c.api.get<{ results: typeof gifs }>(
          `/api/giphy/search?q=${encodeURIComponent(String(v.query))}`,
        );
        setGifs(result.results);
        return;
      }
      if (i.screen === "gimme") {
        const result = await c.api.post(
          `/api/channels/${c.channel}/gimme/requests`,
          {
            request: { media: v.tv ? "tv" : "movie", query: String(v.query) },
            idempotency_key: crypto.randomUUID(),
          },
        );
        setGimmeResult(JSON.stringify(result));
        return;
      }
      if (i.screen === "uploads") {
        if (i.action === "attach" && upload?.status === "ready") {
          setAttachments((previous) => [...new Set([...previous, upload.id])]);
          setView("conversation");
          return;
        }
        if (i.action === "pause") {
          uploader.pause();
          return;
        }
        if (!file.current) throw new Error("Choose a file first");
        const current =
          upload ?? (await uploader.create(c.channel, file.current));
        try {
          await uploader.resume(current.id, file.current);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError"))
            throw error;
        }
        return;
      }
      if (i.screen === "invites-admin") {
        const issued = await c.api.post<{ token: string }>("/api/invites", {
          expires_in_seconds: Number(v.expires_in_seconds),
          server_id: serverId,
        });
        setIssued(
          `${location.origin}/#invite=${encodeURIComponent(issued.token)}`,
        );
        return;
      }
      if (i.screen === "direct-messages") {
        const ids = String(v.member_ids)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await c.api.post("/api/channels", {
          name: String(v.name),
          kind: ids.length > 1 ? "group_dm" : "dm",
          member_ids: ids,
        });
        await c.refresh();
        setView("conversation");
        return;
      }
      if (i.screen === "search" || i.screen === "pins") {
        const q =
          i.screen === "pins"
            ? "pinned=true"
            : `q=${encodeURIComponent(String(v.query))}`;
        setResults(
          (
            await c.api.get<{ messages: Message[] }>(
              `/api/channels/${c.channel}/messages?${q}`,
            )
          ).messages.filter((m) => !c.store.isDeleted(m.id)),
        );
        return;
      }
      if (i.screen === "devices" && i.action === "passkey") {
        await registerPasskey(c.api);
        return;
      }
      if (i.screen === "devices" && id) {
        const current = c.devices.find((d) => d.id === id)?.current;
        await c.api.delete(`/api/devices/${id}`);
        if (current) {
          c.logout();
          setView("login");
        } else await c.loadDevices();
        return;
      }
      if (i.screen === "report") {
        await c.api.post("/api/reports", {
          kind: v.feature ? "feature" : "bug",
          body: String(v.body),
          logs: v.logs_consent ? String(v.logs) : null,
          logs_consent: !!v.logs_consent,
          screenshot_id: null,
          screenshot_consent: false,
        });
        setView("conversation");
        return;
      }
      if (i.screen === "reports-admin" && id) {
        await c.api.patch(`/api/reports/${id}`, { status: "resolved" });
        await c.loadReports();
        return;
      }
      if (i.screen === "notifications" && i.action === "enable") {
        if ("Notification" in window) await Notification.requestPermission();
        return;
      }
    });
  const screen = (
    props: Omit<ScreenProps, "onIntent" | "busy" | "error">,
    key?: string | number,
  ) => (
    <Screen
      key={key}
      {...props}
      actions={[
        ...(props.actions ?? []),
        ...(c.auth &&
        props.id === view &&
        !["shell", "conversation", "composer"].includes(props.id)
          ? [{ id: "back", label: "Back to conversation" }]
          : []),
      ]}
      busy={props.id === "uploads" ? false : c.busy}
      error={c.error || undefined}
      onIntent={intent}
    />
  );
  if (!c.auth)
    return (
      <div
        onInput={(event) => {
          const input = event.target;
          if (
            input instanceof HTMLInputElement &&
            (input.name === "username" || input.name === "server_origin")
          )
            authFields.current[input.name] = input.value;
        }}
      >
        {screen(
          {
            id:
              view === "setup"
                ? "setup"
                : view === "invite"
                  ? "invite"
                  : "login",
            title:
              view === "setup"
                ? "Initialize Chriscord"
                : view === "invite"
                  ? "Accept invitation"
                  : "Sign in to Chriscord",
            phase: "ready",
            fields: [
              {
                name: "server_origin",
                label: "Server URL (blank for this server)",
                value: import.meta.env.VITE_API_ORIGIN ?? "",
              },
              ...(view === "setup"
                ? [
                    {
                      name: "setup_token",
                      label: "Setup token",
                      type: "password" as const,
                      required: true,
                    },
                  ]
                : []),
              ...(view === "invite"
                ? [
                    {
                      name: "token",
                      label: "Invite token",
                      type: "password" as const,
                      value: invite,
                      required: true,
                    },
                  ]
                : []),
              { name: "username", label: "Username", required: true },
              {
                name: "password",
                label: "Password (at least 12 characters)",
                type: "password",
                required: true,
              },
            ],
            submitLabel:
              view === "setup"
                ? "Initialize"
                : view === "invite"
                  ? "Join"
                  : "Sign in",
            actions: [
              { id: "passkey", label: "Sign in with passkey" },
              { id: "login", label: "Sign in" },
              { id: "invite", label: "Use invitation" },
              { id: "setup", label: "First-run setup" },
            ],
          },
          view,
        )}
      </div>
    );
  const common = {
    phase: c.online ? ("ready" as const) : ("offline" as const),
  };
  const shell = screen({
    id: "shell",
    title: `Chriscord — ${c.auth.user.username}`,
    ...common,
    items: c.channels.map((ch) => ({
      id: ch.id,
      text: ch.name,
      actions: [{ id: "select", label: `Open ${ch.name}` }],
    })),
    actions: [
      { id: "direct-messages", label: "New DM" },
      { id: "servers-admin", label: "Servers" },
      ...(c.auth.user.is_owner
        ? [
            { id: "channels-admin", label: "Create channel" },
            { id: "roles-admin", label: "Manage roles" },
          ]
        : []),
      { id: "members", label: "Members" },
      { id: "search", label: "Search" },
      { id: "pins", label: "Pins" },
      { id: "devices", label: "Devices" },
      { id: "notifications", label: "Notifications" },
      { id: "report", label: "Report a problem" },
      { id: "settings", label: "Capabilities" },
      { id: "uploads", label: "Upload file" },
      { id: "gifs", label: "Giphy picker" },
      { id: "voice", label: "Voice and video" },
      { id: "activities", label: "Activity controls" },
      { id: "gimme", label: "Gimme request (dry run)" },
      ...(c.auth.user.is_owner
        ? [
            { id: "invites-admin", label: "Issue invitation" },
            { id: "reports-admin", label: "Review reports" },
          ]
        : []),
      { id: "logout", label: "Sign out" },
    ],
  });
  let content;
  if (view === "conversation")
    content = (
      <>
        {screen({
          id: "conversation",
          title:
            c.channels.find((ch) => ch.id === c.channel)?.name ??
            "Conversation",
          ...common,
          actions: [{ id: "read", label: "Mark read" }],
          items: [
            ...c.typers.map((id) => ({
              id: `typing-${id}`,
              text: `${userName(id)} is typing…`,
            })),
            ...c.messages.map((m) => ({
              id: m.id,
              richText: markdownTokens(m.body),
              text: `${userName(m.author_id)}: ${m.body}${m.reply_to ? " (reply)" : ""}${m.pinned ? " (pinned)" : ""}${(m.reactions ?? []).map((r) => ` ${r.emoji}`).join("")}`,
              actions: [
                { id: "reply", label: "Reply" },
                ...(firstPreviewLink(m.body)
                  ? [{ id: "preview-link", label: "Preview link" }]
                  : []),
                { id: "react", label: "React 👍" },
                { id: "pin", label: m.pinned ? "Unpin" : "Pin" },
                ...(m.author_id === c.auth!.user.id
                  ? [{ id: "edit", label: "Edit" }]
                  : []),
                ...(m.author_id === c.auth!.user.id || c.auth!.user.is_owner
                  ? [{ id: "unsend", label: "Unsend" }]
                  : []),
              ],
            })),
          ],
        })}
        {screen(
          {
            id: "composer",
            title: editing
              ? "Edit message"
              : reply
                ? "Reply to message"
                : "Message",
            ...common,
            fields: [
              { name: "body", label: "Message", value: draft, required: true },
            ],
            items: [
              ...mentionCandidates(draft, c.members).map((m) => ({
                id: m.id,
                text: `@${m.username}`,
                actions: [{ id: "mention", label: `Mention ${m.username}` }],
              })),
              ...roleCandidates(draft, roles).map((role) => ({
                id: `role-${role.id}`,
                text: `@${role.name} (role)`,
                actions: [
                  { id: "mention-role", label: `Mention role ${role.name}` },
                ],
              })),
            ],
            submitLabel: editing ? "Save edit" : "Send",
            actions:
              reply || editing ? [{ id: "cancel", label: "Cancel" }] : [],
          },
          formEpoch,
        )}
      </>
    );
  else if (view === "invites-admin")
    content = screen({
      id: view,
      title: "Single-use invitation",
      ...common,
      fields: [
        {
          name: "expires_in_seconds",
          label: "Expires in seconds",
          type: "number",
          value: "3600",
          required: true,
        },
      ],
      submitLabel: "Create invitation",
      items: issued ? [{ id: "issued", text: issued }] : [],
    });
  else if (view === "direct-messages")
    content = screen({
      id: view,
      title: "Create direct message",
      ...common,
      fields: [
        { name: "name", label: "Conversation name", required: true },
        {
          name: "member_ids",
          label: "Member IDs (comma-separated)",
          required: true,
        },
      ],
      items: c.members
        .filter((m) => m.id !== c.auth!.user.id)
        .map((m) => ({ id: m.id, text: `${m.username}: ${m.id}` })),
    });
  else if (view === "members")
    content = screen({
      id: view,
      title: "Members",
      ...common,
      items: c.members.map((m) => ({
        id: m.id,
        text: `@${m.username}${m.is_owner ? " (owner)" : ""}`,
      })),
    });
  else if (view === "search" || view === "pins")
    content = screen({
      id: view,
      title: view === "search" ? "Search messages" : "Pinned messages",
      ...common,
      fields:
        view === "search"
          ? [{ name: "query", label: "Search query", required: true }]
          : [],
      submitLabel: view === "pins" ? "Load pins" : "Search",
      items: results
        .filter((m) => !c.store.isDeleted(m.id))
        .map((m) => ({ id: m.id, text: m.body })),
    });
  else if (view === "devices")
    content = screen({
      id: view,
      title: "Device sessions",
      ...common,
      actions: [
        {
          id: "passkey",
          label: "Add passkey",
          disabled: c.capabilities.passkeys !== true,
        },
      ],
      items: c.devices.map((d) => ({
        id: d.id,
        text: `${d.device_name}${d.current ? " (this device)" : ""}`,
        actions: [{ id: "revoke", label: "Revoke" }],
      })),
    });
  else if (view === "notifications")
    content = screen({
      id: view,
      title: "Notifications",
      ...common,
      items: c.noticeList.map((n) => ({
        id: n.id,
        text: `Message ${n.message_id}`,
      })),
      actions: [{ id: "enable", label: "Enable desktop notifications" }],
    });
  else if (view === "servers-admin")
    content = screen({
      id: view,
      title: "Servers",
      ...common,
      fields: c.auth.user.is_owner
        ? [{ name: "name", label: "New server name", required: true }]
        : undefined,
      submitLabel: "Create server",
      items: servers.map((server) => ({
        id: server.id,
        text: `${server.name}: ${server.id}`,
        actions: [{ id: "select", label: `Open server ${server.name}` }],
      })),
    });
  else if (view === "channels-admin")
    content = screen({
      id: view,
      title: "Create channel",
      ...common,
      fields: [
        { name: "name", label: "Channel name", required: true },
        { name: "server_id", label: "Server ID", value: serverId },
        { name: "member_ids", label: "Channel member IDs (comma-separated)" },
      ],
      submitLabel: "Create channel",
      items: c.members.map((member) => ({
        id: member.id,
        text: `${member.username}: ${member.id}`,
      })),
    });
  else if (view === "roles-admin")
    content = screen({
      id: view,
      title: `Roles for ${serverId}`,
      ...common,
      fields: [
        { name: "name", label: "New role name" },
        { name: "role_id", label: "Existing role ID (to assign)" },
        { name: "user_id", label: "Member ID (to assign)" },
      ],
      submitLabel: "Create role or assign member",
      items: roles.map((role) => ({
        id: role.id,
        text: `${role.name}: ${role.id} (${role.member_ids.length} members)`,
        actions: [{ id: "delete", label: "Delete role" }],
      })),
    });
  else if (view === "media")
    content = screen({
      id: view,
      title: "Link preview (requested by you)",
      ...common,
      items: preview
        ? [
            { id: "host", text: preview.hostname },
            { id: "title", text: preview.title },
            { id: "description", text: preview.description },
            { id: "url", text: preview.url },
          ]
        : [],
    });
  else if (view === "report")
    content = screen({
      id: view,
      title: "Bug report or feature suggestion",
      ...common,
      fields: [
        { name: "body", label: "Description", required: true },
        { name: "feature", label: "Feature suggestion", type: "checkbox" },
        { name: "logs", label: "Optional logs (review and remove secrets)" },
        {
          name: "logs_consent",
          label: "I consent to sending the logs above",
          type: "checkbox",
        },
      ],
      submitLabel: "Submit report",
    });
  else if (view === "plex")
    content = screen({
      id: view,
      title: "Plex library",
      ...common,
      items: [
        ...plexLibraries.map((library) => ({
          id: library.id,
          text: library.title,
          actions: [{ id: "library", label: "Browse library" }],
        })),
        ...plexItems.map((item) => ({
          id: item.id,
          text: `${item.title} (${item.kind})`,
          actions: [
            {
              id: "choose",
              label: "Watch together",
              disabled: activity?.host !== c.auth!.user.id,
            },
          ],
        })),
      ],
    });
  else if (view === "activities")
    content = screen({
      id: view,
      title:
        activity?.kind === "plex" && c.capabilities.plex === true
          ? "Plex watch party"
          : "Activity control state — provider playback unavailable",
      ...common,
      items: activity
        ? [
            {
              id: "snapshot",
              text: `${activity.kind} revision ${activity.revision}; ${activity.playback.playing ? "playing" : "paused"}; position ${activity.playback.position_ms}; controller ${activity.controller ? userName(activity.controller.user_id) : "none"}`,
            },
            ...activity.queue.map((t) => ({ id: t.id, text: t.title })),
            ...(plexError ? [{ id: "plex-error", text: plexError }] : []),
          ]
        : ["plex", "dj", "vm"].map((kind) => ({
            id: kind,
            text: kind,
            actions: [{ id: "start", label: `Start ${kind} control session` }],
          })),
      fields: activity
        ? [
            {
              name: "command",
              label: "Control command (select, enqueue, seek, handoff)",
              value:
                activity.kind === "plex"
                  ? "select"
                  : activity.kind === "dj"
                    ? "enqueue"
                    : "handoff",
            },
            { name: "media_id", label: "Plex item ID" },
            {
              name: "duration_ms",
              label: "Duration in milliseconds",
              type: "number",
              value: "60000",
            },
            { name: "title", label: "Track title" },
            { name: "source", label: "Track link" },
            { name: "user_id", label: "Handoff user ID" },
            {
              name: "position_ms",
              label: "Seek position in milliseconds",
              type: "number",
            },
          ]
        : undefined,
      submitLabel: "Apply control command",
      actions: activity
        ? [
            {
              id: "browse-plex",
              label: "Browse Plex library",
              disabled:
                activity.kind !== "plex" || c.capabilities.plex !== true,
            },
            {
              id: "subtitles",
              label: plexSubtitles ? "Hide subtitles" : "Show subtitles",
              disabled: activity.kind !== "plex" || !plexManifest,
            },
            { id: "play", label: "Play" },
            { id: "pause", label: "Pause" },
            {
              id: "vote_skip",
              label: "Vote to skip",
              disabled: activity.kind !== "dj",
            },
            {
              id: "request_control",
              label: "Request VM control",
              disabled: activity.kind !== "vm",
            },
            {
              id: "stop",
              label: "Stop activity",
              disabled: activity.host !== c.auth.user.id,
            },
          ]
        : [],
    });
  else if (view === "voice")
    content = (
      <>
        {screen({
          id: view,
          title: "Voice and video",
          phase:
            voiceStatus.phase === "failed"
              ? "error"
              : voiceStatus.phase === "connecting"
                ? "loading"
                : "ready",
          items: [
            {
              id: "status",
              text: `${voiceStatus.phase}; received ${voiceStatus.receivedBytes} bytes; decoded ${voiceStatus.decodedFrames} frames${voiceStatus.error ? `; ${voiceStatus.error}` : ""}`,
            },
          ],
          fields: [
            {
              name: "bitrate",
              label: "Opus target bitrate",
              type: "number",
              value: "510000",
            },
            {
              name: "noise_suppression",
              label: "Noise suppression (optional)",
              type: "checkbox",
            },
          ],
          submitLabel: "Apply audio preferences",
          actions: [
            {
              id: "join",
              label: "Join with microphone and camera",
              disabled:
                voiceStatus.phase === "live" ||
                voiceStatus.phase === "connecting",
            },
            {
              id: "leave",
              label: "Leave voice",
              disabled: voiceStatus.phase === "idle",
            },
            {
              id: "share",
              label: "Share screen (replaces camera; microphone audio)",
              disabled: voiceStatus.phase !== "live",
            },
            {
              id: "mute",
              label: muted ? "Unmute" : "Mute",
              disabled: voiceStatus.phase !== "live",
            },
          ],
        })}
      </>
    );
  else if (view === "gifs")
    content = screen({
      id: view,
      title: "Powered by GIPHY",
      phase: c.capabilities.giphy === true ? "ready" : "unavailable",
      fields:
        c.capabilities.giphy === true
          ? [{ name: "query", label: "Search GIFs", required: true }]
          : undefined,
      items:
        c.capabilities.giphy === true
          ? gifs.map((gif) => ({
              id: gif.id,
              text: gif.title,
              actions: [{ id: "choose", label: "Choose GIF" }],
            }))
          : [
              {
                id: "unavailable",
                text: "The server has no Giphy API key configured.",
              },
            ],
    });
  else if (view === "gimme")
    content = screen({
      id: view,
      title: "Gimme request — dry run only, no provider request sent",
      ...common,
      fields: [
        { name: "query", label: "Movie or show", required: true },
        { name: "tv", label: "TV show", type: "checkbox" },
      ],
      submitLabel: "Preview request",
      items: gimmeResult ? [{ id: "result", text: gimmeResult }] : [],
    });
  else if (view === "uploads")
    content = screen({
      id: view,
      title: "Resumable upload",
      ...common,
      fields: [{ name: "file", label: "File", type: "file" }],
      submitLabel: upload ? "Resume upload" : "Upload",
      items: upload
        ? [
            {
              id: upload.id,
              text: `${upload.filename}: ${upload.offset}/${upload.length} bytes (${upload.status})`,
            },
          ]
        : [],
      actions: [
        { id: "pause", label: "Pause" },
        {
          id: "attach",
          label: "Attach to message",
          disabled: upload?.status !== "ready",
        },
      ],
    });
  else if (view === "settings")
    content = screen({
      id: view,
      title: "Server capabilities",
      ...common,
      items: Object.entries(c.capabilities).map(([id, value]) => ({
        id,
        text: `${id}: ${value === true ? "available" : "unavailable"}`,
      })),
    });
  else if (view === "reports-admin")
    content = screen({
      id: view,
      title: "Reports",
      ...common,
      items: c.reports.map((r) => ({
        id: r.id,
        text: `${r.kind}: ${r.body} (${r.status})`,
        actions: [
          {
            id: "resolve",
            label: "Resolve",
            disabled: r.status === "resolved",
          },
        ],
      })),
    });
  return (
    <div
      onInput={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === "file") {
          file.current = target.files?.[0];
          if (
            upload &&
            file.current &&
            (file.current.name !== upload.filename ||
              String(file.current.size) !== upload.length)
          )
            setUpload(undefined);
        }
        if (
          target instanceof HTMLInputElement &&
          target.name === "body" &&
          view === "conversation"
        ) {
          setDraft(target.value);
          if (Date.now() - lastTyping.current > 3000) {
            lastTyping.current = Date.now();
            void c.api
              .post(`/api/channels/${c.channel}/typing`, { active: true })
              .catch(() => {});
          }
        }
      }}
    >
      {shell}
      {content}
      {voiceStatus.streams.map((stream) => (
        <MediaTrack key={stream.id} stream={stream} />
      ))}
      {plexManifest && activity?.kind === "plex" && (
        <PlexMedia
          api={c.api}
          manifest={plexManifest}
          snapshot={activity}
          subtitles={plexSubtitles}
          onError={setPlexError}
        />
      )}
    </div>
  );
}
