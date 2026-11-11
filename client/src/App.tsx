import { resetVm, sendVmInput } from "./transport/vm";
import { clearNativePush, enableNativePush, nativePushStatus, type NativePushStatus } from "./transport/nativePush";
import { gimmeStatusText } from "./data/gimme";
import { messageDetails } from "./data/messageView";
import { submitReport, reportScreenshot } from "./transport/reports";
import {markdownTokens} from "./data/markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceSession, availableVoiceInputs, type VoiceStatus, type VoiceInputs, type VoiceDevice } from "./transport/voice";
import { PlexMedia } from "./data/PlexMedia";
import { DjMedia } from "./data/DjMedia";
import { UploadedMedia } from "./data/UploadedMedia";
import { MediaTrack } from "./data/MediaTrack";
import { firstPreviewLink, previewLink, type LinkPreview } from "./data/embeds";
import { Screen } from "./ui/Screen";
import type { Intent, ScreenId, ScreenProps } from "./contracts/ui";
import { useHousecall } from "./hooks/useHousecall";
import { isDesktopTauri, registerPasskey } from "./transport/passkeys";
import { subscribeInviteLinks, type InviteLink } from "./transport/deepLinks";
import { ResumableUpload, uploadScanMessage, type Upload } from "./transport/uploads";
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
  const c = useHousecall();
  const desktopPasskeysUnavailable = isDesktopTauri();
  const [nativePush, setNativePush] = useState<NativePushStatus>();
  useEffect(() => {
    let cancelled = false;
    void nativePushStatus().then(status => { if (!cancelled) setNativePush(status); })
      .catch(error => { if (!cancelled) void c.run(async () => { throw error; }); });
    return () => { cancelled = true; };
  }, [c.auth?.user.id]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    phase: "idle",
    streams: [],
    receivedBytes: 0,
    decodedFrames: 0,
  });
  const voice = useMemo(() => new VoiceSession(c.api, setVoiceStatus), [c.api]);
  const [muted, setMuted] = useState(false);
  const [voiceInputs, setVoiceInputs] = useState<VoiceInputs>({});
  const [voiceDevices, setVoiceDevices] = useState<VoiceDevice[]>([]);
  useEffect(() => () => voice.close(), [voice]);
  useEffect(() => {
    if (!c.auth) { voice.close(); setVoiceInputs({}); setVoiceDevices([]); setMuted(false); }
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
  const screenshotFile = useRef<File | undefined>(undefined);
  useEffect(() => {
    screenshotFile.current = undefined; file.current = undefined;
    setUpload(undefined); setDerivation(undefined); setPlayingUpload(undefined);
    setUploadPlaybackError(""); setAttachments([]);
  }, [c.auth?.user.id]);
  const [upload, setUpload] = useState<Upload>();
  const [derivation, setDerivation] = useState<{ id: string; status: string; error?: string }>();
  const [playingUpload, setPlayingUpload] = useState<{ message: string; attachment: string; path: string }>();
  const [uploadPlaybackError, setUploadPlaybackError] = useState("");
  useEffect(() => {
    if (playingUpload && !c.messages.some(m => m.id === playingUpload.message && m.attachments?.some(a => a.id === playingUpload.attachment && a.video_path === playingUpload.path)))
      setPlayingUpload(undefined);
  }, [c.messages, playingUpload]);
  useEffect(() => {
    if (!derivation || !["queued", "running"].includes(derivation.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void c.api.get<typeof derivation>(`/api/media-jobs/${derivation.id}`, controller.signal)
        .then(value => { if (!controller.signal.aborted) setDerivation(value); })
        .catch(error => { if (!controller.signal.aborted) setDerivation({ id: derivation.id, status: "failed", error: String(error) }); });
    }, 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [derivation?.id, derivation?.status, c.api]);
  const uploader = useMemo(
    () => new ResumableUpload(c.api, setUpload),
    [c.api],
  );
  useEffect(() => {
    uploader.pause();
    return () => uploader.pause();
  }, [uploader, c.auth]);
  const [draft, setDraft] = useState("");
  const lastTyping = useRef(0);
  const authFields = useRef({
    username: "",
    server_origin: import.meta.env.VITE_API_ORIGIN ?? "",
  });
  const [pendingInvite, setPendingInvite] = useState<InviteLink>();
  useEffect(() => subscribeInviteLinks(setPendingInvite, error => {
    void c.run(async () => { throw error; });
  }), [c.run]);
  useEffect(() => {
    if (!pendingInvite) return;
    if (c.auth) {
      void c.run(async () => { throw new Error("Sign out before accepting another invitation"); });
      return;
    }
    // Prefill only. Receiving a link never redeems it or replaces the current account.
    authFields.current.server_origin = pendingInvite.server_origin;
    setInvite(pendingInvite.token);
    setView("invite");
    setFormEpoch(value => value + 1);
    setPendingInvite(undefined);
  }, [pendingInvite, c.auth, c.run]);
  const [servers, setServers] = useState<Server[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [serverId, setServerId] = useState("home");
  const [preview, setPreview] = useState<LinkPreview>();
  const pendingGimme = useRef<{ intent: string; key: string } | undefined>(undefined);
  useEffect(() => { pendingGimme.current = undefined; }, [c.auth?.user.id]);
  const [gifs, setGifs] = useState<
    { id: string; title: string; source_url: string }[]
  >([]);
  const [attachments, setAttachments] = useState<{ id: string; filename: string }[]>([]);
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
  const [vmReset, setVmReset] = useState<{ operation: string; channel: string; phase: "confirm" | "running" | "retry"; outcome?: string; canRetry?: boolean; result?: string }>();
  const vmResetEpoch = useRef(0);
  const [vmResetDiscovery, setVmResetDiscovery] = useState<"loading" | "ready" | "error">("loading");
  const [vmResetDiscoveryGeneration, setVmResetDiscoveryGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    vmResetEpoch.current++;
    setVmReset(undefined);
    setVmResetDiscovery("loading");
    if (activity?.kind === "vm" && c.auth && c.capabilities.vm_reset === true) {
      void c.api.get<{ operation?: string; outcome: string; can_retry?: boolean }>(`/api/channels/${c.channel}/vm/reset`).then(status => {
        if (cancelled) return;
        setVmResetDiscovery("ready");
        if (status.operation && status.outcome !== "none") setVmReset({ operation: status.operation, channel: c.channel, phase: "retry", outcome: status.outcome, canRetry: status.can_retry,
          result: status.outcome === "reset" ? "VM reset complete. Start shared VM video and audio to watch again." : status.outcome === "rolled_back" ? "Previous VM disk restored after rollback." : undefined });
      }).catch(() => { if (!cancelled) setVmResetDiscovery("error"); });
    }
    return () => { cancelled = true; };
  }, [c.channel, c.auth, activity?.kind, c.capabilities.vm_reset, c.api, vmResetDiscoveryGeneration]);
  const [vmMedia, setVmMedia] = useState<{configured:boolean;armed:boolean;phase:string;peer_id?:number}>();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setVmMedia(undefined);
    if (activity?.kind !== "vm" || !c.auth || c.capabilities.vm_media !== true) return;
    const poll = async () => {
      try {
        const result = await c.api.get<NonNullable<typeof vmMedia>>(`/api/channels/${c.channel}/vm/media`);
        if (!stopped) setVmMedia(result);
      } catch { if (!stopped) setVmMedia({ configured:true, armed:false, phase:"unavailable" }); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [activity?.kind, c.auth?.user.id, c.channel, c.api, c.capabilities.vm_media]);
  const [djAudio, setDjAudio] = useState<string>();
  const [djError, setDjError] = useState("");
  const [djResults, setDjResults] = useState<{ title: string; source: string; duration_ms: number }[]>([]);
  const djTrackId = activity?.kind === "dj" ? activity.playback.media_id : null;
  useEffect(() => {
    let cancelled = false;
    setDjAudio(undefined);
    setDjError("");
    if (djTrackId && voiceStatus.phase === "live" && c.capabilities.dj === true)
      void c.api.get<{ track: { id: string; audio_url: string } | null }>(`/api/channels/${c.channel}/dj/playback`)
        .then(result => { if (!cancelled && result.track?.id === djTrackId) setDjAudio(result.track.audio_url); })
        .catch(error => { if (!cancelled) setDjError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [djTrackId, voiceStatus.phase, c.channel, c.api, c.capabilities.dj]);
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
        await clearNativePush();
        const ds = await c.api.get<{
          devices: { id: string; current: boolean }[];
        }>("/api/devices");
        const current = ds.devices.find((d) => d.current);
        if (current) await c.api.delete(`/api/devices/${current.id}`);
        await c.logout();
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
        if (i.action === "report") screenshotFile.current = undefined;
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
        if (i.action === "close-video") { setPlayingUpload(undefined); return; }
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
        if (i.action.startsWith("play-attachment:")) {
          const attachment = m.attachments?.find(a => a.id === i.action.slice("play-attachment:".length));
          if (attachment?.video_path) { setUploadPlaybackError(""); setPlayingUpload({ message: m.id, attachment: attachment.id, path: attachment.video_path }); }
          return;
        }
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
        if (i.action === "remove-attachment" && id) {
          setAttachments(previous => previous.filter(attachment => attachment.id !== id));
          return;
        }
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
            attachment_ids: attachments.map(attachment => attachment.id),
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
      if (i.screen === "dj") {
        if (i.action === "choose" && id) {
          const result = djResults[Number(id)];
          if (result) await c.api.post(`/api/channels/${c.channel}/dj/queue`, { query: result.source });
          await c.loadActivity();
          setView("activities");
        } else if (i.action === "submit") {
          setDjResults((await c.api.post<{ results: typeof djResults }>(`/api/channels/${c.channel}/dj/search`, { query: String(v.query) })).results);
        }
        return;
      }
      if (i.screen === "activities") {
        if (i.action === "refresh-vm-reset") { setVmResetDiscoveryGeneration(value => value + 1); return; }
        if (activity?.kind === "vm" && i.action === "reset-vm" && vmResetDiscovery === "ready") {
          setVmReset({ operation: crypto.randomUUID(), channel: c.channel, phase: "confirm" }); return;
        }
        if (i.action === "cancel-reset-vm" && vmReset?.phase === "confirm") { setVmReset(undefined); return; }
        if (i.action === "check-reset-vm" && vmReset?.channel === c.channel) {
          const epoch = vmResetEpoch.current;
          const status = await c.api.get<{ operation?: string; outcome: string; can_retry?: boolean }>(`/api/channels/${c.channel}/vm/reset`);
          if (epoch === vmResetEpoch.current && status.operation === vmReset.operation) setVmReset(current => current?.operation === vmReset.operation && current.channel === vmReset.channel ? { ...current, phase: "retry", outcome: status.outcome, canRetry: status.can_retry, result:
            status.outcome === "reset" ? "VM reset complete. Start shared VM video and audio to watch again." :
            status.outcome === "rolled_back" ? "Previous VM disk restored after rollback." : undefined } : current);
          return;
        }
        if (activity?.kind === "vm" && (i.action === "confirm-reset-vm" || (i.action === "retry-existing-vm-reset" && vmReset?.canRetry)) && vmReset?.channel === c.channel && vmReset.phase !== "running") {
          const epoch = vmResetEpoch.current;
          const pending = { ...vmReset, phase: "running" as const };
          setVmReset(pending);
          try {
            const result = await resetVm(c.api, c.channel, activity, c.auth!.user.id, pending.operation);
            setVmReset(current => epoch === vmResetEpoch.current && current?.operation === pending.operation && current.channel === pending.channel ? { ...pending, phase: "retry", outcome: result.outcome, result: result.outcome === "reset" ? "VM reset complete. Start shared VM video and audio to watch again." : "Reset was rolled back. Your previous VM disk was restored. Request control and try a new reset." } : current);
          } catch (error) {
            setVmReset(current => epoch === vmResetEpoch.current && current?.operation === pending.operation && current.channel === pending.channel ? { ...pending, phase: "retry", outcome: "unknown" } : current); throw error;
          }
          return;
        }
        if (activity?.kind === "vm" && (i.action === "start-vm-media" || v.command === "start_vm_media")) {
          await c.api.post(`/api/channels/${c.channel}/vm/media`, { expected_revision:activity.revision }); return;
        }
        if (activity?.kind === "vm" && (i.action === "stop-vm-media" || v.command === "stop_vm_media")) {
          await c.api.delete(`/api/channels/${c.channel}/vm/media`); return;
        }
        if (i.action === "browse-dj") { setDjResults([]); setView("dj"); return; }
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
        } else if (activity?.kind === "dj" && c.capabilities.dj === true && i.action === "submit" && v.command === "enqueue") {
          await c.api.post(`/api/channels/${c.channel}/dj/queue`, { query: String(v.source || v.title) });
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
      if (i.screen === "vm" && activity) {
        if (i.action === "key") await sendVmInput(c.api, c.channel, activity, c.auth!.user.id, { type: "key", key: String(v.key) });
        if (i.action === "pointer") await sendVmInput(c.api, c.channel, activity, c.auth!.user.id, { type: "pointer", x: Number(v.x), y: Number(v.y) });
        if (i.action === "click") await sendVmInput(c.api, c.channel, activity, c.auth!.user.id, { type: "click", button: String(v.button) });
        return;
      }
      if (i.screen === "voice") {
        if (i.action === "refresh-devices") setVoiceDevices(await availableVoiceInputs());
        if (i.action === "select-inputs") setVoiceInputs({ microphone: String(v.microphone || ""), camera: String(v.camera || "") });
        if (i.action === "join" || i.action === "join-audio") {
          setMuted(false);
          await voice.join(c.channel, i.action === "join", voiceInputs);
        }
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
        const request = { media: v.tv ? "tv" : "movie", query: String(v.query) };
        const fingerprint = JSON.stringify([c.channel, request]);
        if (pendingGimme.current?.intent !== fingerprint)
          pendingGimme.current = { intent: fingerprint, key: crypto.randomUUID() };
        await c.api.post(
          `/api/channels/${c.channel}/gimme/requests`,
          {
            request,
            idempotency_key: pendingGimme.current.key,
          },
        );
        await c.refresh();
        pendingGimme.current = undefined;
        return;
      }
      if (i.screen === "uploads") {
        if (i.action === "refresh-scan" && upload) {
          const refreshed = await uploader.refreshScan(upload.id);
          if (refreshed.status === "quarantined") throw new Error(uploadScanMessage(refreshed.scan));
          return;
        }
        if (i.action === "retry-scan" && upload?.status === "quarantined") { await uploader.retryScan(upload.id); return; }
        if (i.action === "derive" && upload?.status === "ready") {
          setDerivation(await c.api.post(`/api/uploads/${upload.id}/derive`, {}));
          return;
        }
        if (i.action === "attach" && upload?.status === "ready") {
          setAttachments((previous) => previous.some(attachment => attachment.id === upload.id) ? previous :
            [...previous, { id: upload.id, filename: upload.filename }]);
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
        const issued = await c.api.post<{ token: string | null; email: string; email_sent: boolean }>("/api/invites", {
          expires_in_seconds: Number(v.expires_in_seconds),
          email: String(v.email),
          server_id: serverId,
        });
        setIssued(
          issued.email_sent
            ? `Invitation email sent to ${issued.email}`
            : `${new URL(c.api.mediaRequest("/api/invites").url).origin}/#invite=${encodeURIComponent(issued.token ?? "")}`,
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
        if (current) await clearNativePush();
        await c.api.delete(`/api/devices/${id}`);
        if (current) {
          await c.logout();
          setView("login");
        } else await c.loadDevices();
        return;
      }
      if (i.screen === "report") {
        await submitReport(c.api, c.channel, {
          kind: v.feature ? "feature" : "bug",
          body: String(v.body),
          logs: String(v.logs ?? ""),
          logsConsent: !!v.logs_consent,
          screenshot: screenshotFile.current,
          screenshotConsent: !!v.screenshot_consent,
        });
        screenshotFile.current = undefined;
        setView("conversation");
        return;
      }
      if (i.screen === "reports-admin" && id) {
        if (i.action === "screenshot") {
          const blob = await reportScreenshot(c.api, id, AbortSignal.timeout(30000));
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objectUrl;
          link.download = `report-screenshot.${blob.type === "image/png" ? "png" : blob.type === "image/jpeg" ? "jpg" : "webp"}`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
          return;
        }
        await c.api.patch(`/api/reports/${id}`, { status: "resolved" });
        await c.loadReports();
        return;
      }
      if (i.screen === "notifications" && i.action === "enable") {
        const status = await nativePushStatus();
        if (status.supported) {
          if (!c.auth) throw new Error("Sign in before enabling background notifications");
          if (!status.configured) throw new Error("Background notifications are unavailable in this app build");
          const origin = new URL(c.api.mediaRequest("/api/me").url).origin;
          await enableNativePush(origin, c.auth);
          setNativePush(await nativePushStatus());
        } else if ("Notification" in window) await Notification.requestPermission();
        return;
      }
      if (i.screen === "notifications" && i.action === "disable-native") {
        await clearNativePush();
        setNativePush(await nativePushStatus());
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
                ? "Initialize Housecall"
                : view === "invite"
                  ? "Accept invitation"
                  : "Sign in to Housecall",
            phase: "ready",
            fields: [
              {
                name: "server_origin",
                label: "Server URL",
                value: authFields.current.server_origin,
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
              { name: "username", label: view === "invite" ? "Display name" : "Username", required: true },
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
              ...(view === "login" ? [{
                id: "passkey",
                label: desktopPasskeysUnavailable ? "Passkeys coming soon on desktop" : "Sign in with passkey",
                disabled: desktopPasskeysUnavailable,
              }] : []),
              { id: "login", label: "Sign in" },
              { id: "invite", label: "Use invitation" },
              { id: "setup", label: "First-run setup" },
            ],
          },
          `${view}-${formEpoch}`,
        )}
      </div>
    );
  const common = {
    phase: c.online ? ("ready" as const) : ("offline" as const),
  };
  const shell = screen({
    id: "shell",
    title: `Housecall — ${c.auth.user.username}`,
    ...common,
    items: c.channels.map((ch) => ({
      id: ch.id,
      text: ch.name,
      channel: { kind: ch.kind, serverId: ch.server_id ?? undefined, current: ch.id === c.channel },
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
      ...(activity || c.capabilities.plex === true || c.capabilities.dj === true
        ? [{ id: "activities", label: activity?.kind === "vm" ? "Shared VM (coming soon)" : "Activity controls" }]
        : []),
      { id: "gimme", label: c.capabilities.gimme_dry_run === false ? "Gimme request" : "Gimme request (dry run)" },
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
          actions: [{ id: "read", label: "Mark read" }, ...(playingUpload ? [{ id: "close-video", label: "Close video" }] : [])],
          items: [
            ...c.typers.map((id) => ({
              id: `typing-${id}`,
              text: `${userName(id)} is typing…`,
            })),
            ...c.messages.map((m) => ({
              id: m.id,
              message: messageDetails(m, c.auth!.user.id, userName, c.messages),
              richText: markdownTokens(m.body),
              text: `${userName(m.author_id)}: ${m.body}${m.reply_to ? " (reply)" : ""}${m.pinned ? " (pinned)" : ""}${(m.reactions ?? []).map((r) => ` ${r.emoji}`).join("")}`,
              actions: [
                ...(m.attachments ?? []).filter(a => a.video_path).map(a => ({ id: `play-attachment:${a.id}`, label: `Play ${a.filename}` })),
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
            ...c.gimmeRequests.map(request => ({ id: `gimme-${request.id}`, text: `${request.request.query}: ${gimmeStatusText(request)}` })),
            ...(uploadPlaybackError ? [{ id: "upload-playback-error", text: uploadPlaybackError }] : []),
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
            attachments,
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
      title: "Invite a friend",
      ...common,
      fields: [
        {
          name: "email",
          label: "Friend's email address",
          type: "email",
          required: true,
        },
        {
          name: "expires_in_seconds",
          label: "Expires in seconds",
          type: "number",
          value: "604800",
          required: true,
        },
      ],
      submitLabel: "Send invitation",
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
          disabled: desktopPasskeysUnavailable || c.capabilities.passkeys !== true,
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
      actions: nativePush?.supported ? [
        { id: "enable", label: "Enable background notifications" },
        ...(nativePush.enabled ? [{ id: "disable-native", label: "Disable background notifications" }] : []),
      ] : [{ id: "enable", label: "Enable desktop notifications" }],
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
        { name: "report_screenshot", label: "Optional screenshot (PNG, JPEG or WebP)", type: "file" },
        { name: "screenshot_consent", label: "I consent to sending the selected screenshot", type: "checkbox" },
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
  else if (view === "dj")
    content = screen({ id: view, title: "DJ Steve Forever — synthetic placeholder voice", ...common,
      fields: [{ name: "query", label: "Song search or YouTube, SoundCloud, Spotify link", required: true }],
      submitLabel: "Search songs",
      items: djResults.map((track, index) => ({ id: String(index), text: `${track.title} (${Math.round(track.duration_ms / 1000)} seconds)`, actions: [{ id: "choose", label: "Prepare and queue" }] })),
    });
  else if (view === "activities")
    content = screen({
      id: view,
      vm: activity?.kind === "vm" && vmMedia ? { ...vmMedia, peerId:vmMedia.peer_id === undefined ? undefined : String(vmMedia.peer_id),
        reset: vmReset ? { phase: vmReset.phase, message: vmReset.result } : undefined,
        streamIds:voiceStatus.streams.filter(stream => voiceStatus.sourcePeers?.[stream.id] === String(vmMedia.peer_id)).map(stream => stream.id) } : undefined,
      title:
        activity?.kind === "vm"
          ? "Shared VM (coming soon)"
          : activity?.kind === "plex" && c.capabilities.plex === true
          ? "Plex watch party"
          : activity?.kind === "dj" && c.capabilities.dj === true
            ? "DJ Steve Forever — synthetic voice"
          : activity
            ? "Activity control state — provider playback unavailable"
            : c.capabilities.plex === true || c.capabilities.dj === true
              ? "Together"
              : "Activities coming soon",
      ...common,
      phase: activity
        ? activity.kind === "plex"
          ? c.capabilities.plex === true ? "ready" : "unavailable"
          : activity.kind === "dj"
            ? c.capabilities.dj === true ? "ready" : "unavailable"
            : "unavailable"
        : c.capabilities.plex === true || c.capabilities.dj === true ? "ready" : "unavailable",
      items: activity
        ? [
            {
              id: "snapshot",
              text: `${activity.kind} revision ${activity.revision}; ${activity.playback.playing ? "playing" : "paused"}; position ${activity.playback.position_ms}; controller ${activity.controller ? userName(activity.controller.user_id) : "none"}`,
              activity: { duration_ms: activity.playback.duration_ms, media_id: activity.playback.media_id,
                hostName: userName(activity.host), controller_expires_at: activity.controller?.expires_at_ms,
                isHost: activity.host === c.auth!.user.id, canStop: activity.host === c.auth!.user.id },
            },
            ...activity.queue.map((t) => ({ id: t.id, text: t.title,
              queue: { requested_by: t.requested_by, votedToSkip: t.id === activity.playback.media_id && activity.skip_votes.includes(c.auth!.user.id) } })),
            ...(activity.kind === "vm" && vmReset ? [{ id: "vm-reset-status", text: vmReset.result || (vmReset.phase === "confirm" ? "Reset discards all changes since the saved snapshot. Shared video and audio will stop." : vmReset.phase === "running" ? "Stopping the VM, restoring its snapshot, and restarting. Please wait." : vmReset.outcome === "pending" ? "The existing reset is pending. Check its outcome; this will not start another reset." : "The reset outcome is unknown. Check the existing operation; this will not start another reset.") }] : []),
            ...(plexError ? [{ id: "plex-error", text: plexError }] : []),
            ...(djError ? [{ id: "dj-error", text: djError }] : []),
          ]
        : [
            ...(c.capabilities.plex === true ? [{ id: "plex", text: "plex", actions: [{ id: "start", label: "Start Plex watch party" }] }] : []),
            ...(c.capabilities.dj === true ? [{ id: "dj", text: "dj", actions: [{ id: "start", label: "Start DJ session" }] }] : []),
          ],
      fields: activity && (activity.kind === "plex" ? c.capabilities.plex === true : activity.kind === "dj" && c.capabilities.dj === true)
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
            ...(activity.kind === "vm" ? (vmReset?.channel === c.channel && !vmReset.result ? [
              { id: vmReset.phase === "retry" ? "check-reset-vm" : "confirm-reset-vm", label: vmReset.phase === "running" ? "Resetting VM. Please wait" : vmReset.phase === "retry" ? "Check existing VM reset outcome" : "Discard VM changes and restart from snapshot", disabled: vmReset.phase === "running" || activity.kind === "vm" },
              ...(vmReset.phase === "confirm" ? [{ id: "cancel-reset-vm", label: "Cancel reset" }] : []),
              ...(vmReset.phase === "retry" && vmReset.canRetry ? [{ id: "retry-existing-vm-reset", label: "Retry the same confirmed VM reset", disabled: activity.kind === "vm" }] : []),
            ] : [{ id: "reset-vm", label: "VM reset (coming soon)", disabled: true }, ...(vmResetDiscovery === "error" ? [{ id: "refresh-vm-reset", label: "Retry checking previous VM reset" }] : [])]) : []),
            ...(activity.kind === "vm" ? [{ id: "start-vm-media", label: "Shared VM video and audio (coming soon)", disabled:true },
            { id: "stop-vm-media", label: "Stop shared VM video and audio", disabled:activity.host !== c.auth.user.id || !vmMedia?.armed }] : []),
            { id: "browse-dj", label: "Search songs", disabled: activity.kind !== "dj" || c.capabilities.dj !== true },
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
            { id: "play", label: "Play", disabled: activity.kind === "vm" || (activity.kind === "plex" ? c.capabilities.plex !== true : c.capabilities.dj !== true) },
            { id: "pause", label: "Pause", disabled: activity.kind === "vm" || (activity.kind === "plex" ? c.capabilities.plex !== true : c.capabilities.dj !== true) },
        ...(upload?.status === "quarantined" ? [{ id: "refresh-scan", label: "Check scan status" },
          { id: "retry-scan", label: "Retry scanning", disabled: upload.scan?.verdict === "detected" || upload.scan?.verdict === "pending" || upload.scan?.reason === "engine_limit" || upload.scan?.reason === "encrypted_or_unsupported" }] : []),
            {
              id: "vote_skip",
              label: "Vote to skip",
              disabled: activity.kind !== "dj",
            },
            {
              id: "request_control",
              label: "Request VM control (coming soon)",
              disabled: true,
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
          voice: { inputs: voiceDevices, selected: voiceInputs },
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
              id: "join-audio",
              label: "Join with microphone only",
              disabled: voiceStatus.phase === "live" || voiceStatus.phase === "connecting",
            },
            {
              id: "refresh-devices",
              label: "Refresh input devices",
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
      title: c.capabilities.gimme_dry_run === false ? "Gimme requests" : "Gimme request — dry run only, no provider request sent",
      ...common,
      fields: [
        { name: "query", label: "Movie or show", required: true },
        { name: "tv", label: "TV show", type: "checkbox" },
      ],
      submitLabel: c.capabilities.gimme_dry_run === false ? "Request" : "Preview request",
      items: c.gimmeRequests.map(request => ({ id: request.id, text: `${request.request.query}: ${gimmeStatusText(request)}` })),
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
              uploadScan: upload.scan,
              text: `${upload.filename}: ${upload.offset}/${upload.length} bytes (${upload.status})${derivation ? ` — Video: ${derivation.status}${derivation.error ? ` (${derivation.error})` : ""}` : ""}`,
            },
          ]
        : [],
      actions: [
        { id: "pause", label: "Pause" },
        { id: "derive", label: "Prepare video and thumbnail", disabled: upload?.status !== "ready" || (derivation !== undefined && ["queued", "running"].includes(derivation.status)) },
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
        text: `${r.kind}: ${r.body} (${r.status})${r.logs ? ` — Consented logs: ${r.logs}` : ""}`,
        actions: [
          ...(r.screenshot_id ? [{ id: "screenshot", label: "Download screenshot" }] : []),
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
          if (target.name === "report_screenshot") {
            screenshotFile.current = target.files?.[0];
            return;
          }
          file.current = target.files?.[0];
          if (
            upload &&
            file.current &&
            (file.current.name !== upload.filename ||
              String(file.current.size) !== upload.length)
          )
            { setUpload(undefined); setDerivation(undefined); }
        }
        if (
          (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
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
      {view === "conversation" && playingUpload && <UploadedMedia api={c.api} path={playingUpload.path} onError={setUploadPlaybackError} />}
      {voiceStatus.streams.map((stream) => (
        <MediaTrack key={stream.id} stream={stream} peerId={voiceStatus.sourcePeers?.[stream.id]} />
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
      {djAudio && activity?.kind === "dj" && <DjMedia api={c.api} path={djAudio} channel={c.channel} snapshot={activity} onError={setDjError} />}
    </div>
  );
}
