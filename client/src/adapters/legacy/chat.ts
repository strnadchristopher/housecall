import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ChatMessage, ChatStore, Conversation, Gif, LinkPreview, PendingUpload, Person, RequestCard, ServerEntry, Suggestion } from "../../core/chat";
import type { useHousecall } from "../../hooks/useHousecall";
import type { Message } from "../../state/messages";
import type { Channel, Role, User } from "../../data/types";
import { markdownTokens } from "../../data/markdown";
import { messageDetails } from "../../data/messageView";
import { firstPreviewLink, previewLink } from "../../data/embeds";
import { gimmeStatusText } from "../../data/gimme";
import { completeMention, completeRole, mentionCandidates, mentionedRoles, mentionedUsers, roleCandidates } from "../../data/mentions";
import { ResumableUpload, uploadScanMessage, type Upload } from "../../transport/uploads";
import { UploadedVideo } from "../../transport/video";
import type { HostEntry, HostReport, Hosts } from "./hosts";

export type Housecall = ReturnType<typeof useHousecall>;

const GIF_LINK = /https:\/\/giphy\.com\/gifs\/([A-Za-z0-9]{1,64})(?![A-Za-z0-9])/g;
const VIDEO_NAME = /\.(mp4|m4v|mov|mkv|webm|avi)$/i;

export const person = (user: User): Person => ({ id: user.id, name: user.username, owner: user.is_owner });

function kindOf(channel: Channel): Conversation["kind"] {
  return channel.kind === "channel" ? "channel" : channel.kind === "dm" ? "dm" : "group";
}

export function hostLabel(host: HostEntry): string {
  try {
    return new URL(host.origin || location.origin).host;
  } catch {
    return host.origin;
  }
}

/** ChatStore over the current REST backend (hooks/useHousecall plus transport/*). */
export function useLegacyChat(c: Housecall, host: HostEntry, hosts: Hosts, directory: Record<string, HostReport>, isActive: boolean) {
  const me = c.auth?.user;
  const [serverId, setServerId] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [serverPeople, setServerPeople] = useState<User[]>([]);
  const [draft, setDraftState] = useState("");
  const [reply, setReply] = useState<string>();
  const [editing, setEditing] = useState<Message>();
  const [attached, setAttached] = useState<{ id: string; filename: string }[]>([]);
  const [upload, setUpload] = useState<Upload>();
  const [paused, setPaused] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [derivation, setDerivation] = useState<{ id: string; status: string; error?: string }>();
  const file = useRef<File | undefined>(undefined);
  const lastTyping = useRef(0);
  const gifCache = useRef(new Map<string, Promise<string>>());
  const uploader = useMemo(() => new ResumableUpload(c.api, setUpload), [c.api]);

  const current = c.channels.find(channel => channel.id === c.channel);
  const channelServer = current?.server_id ?? undefined;
  useEffect(() => {
    if (channelServer) setServerId(channelServer);
    else if (!serverId && c.servers[0]) setServerId(c.servers[0].id);
  }, [channelServer, serverId, c.servers]);

  // Account change: nothing from the previous person may linger in the composer.
  useEffect(() => {
    uploader.pause();
    file.current = undefined;
    setUpload(undefined); setDerivation(undefined); setAttached([]); setDraftState("");
    setReply(undefined); setEditing(undefined); setPaused(false); setUploadError("");
    if (!me) { setServerId(""); setRoles([]); setServerPeople([]); }
    for (const pending of gifCache.current.values()) void pending.then(url => URL.revokeObjectURL(url)).catch(() => {});
    gifCache.current.clear();
    return () => uploader.pause();
  }, [me?.id, uploader]);

  useEffect(() => {
    let cancelled = false;
    if (!me || !serverId) return;
    void Promise.all([
      c.api.get<{ roles: Role[] }>(`/api/servers/${serverId}/roles`),
      c.api.get<{ members: User[] }>(`/api/servers/${serverId}/members`),
    ]).then(([r, m]) => { if (!cancelled) { setRoles(r.roles); setServerPeople(m.members); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [serverId, me?.id, c.api, c.members.length]);

  useEffect(() => {
    if (!derivation || !["queued", "running"].includes(derivation.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void c.api.get<NonNullable<typeof derivation>>(`/api/media-jobs/${derivation.id}`, controller.signal)
        .then(value => { if (!controller.signal.aborted) setDerivation(value); })
        .catch(error => { if (!controller.signal.aborted) setDerivation({ id: derivation.id, status: "failed", error: String(error) }); });
    }, 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [derivation?.id, derivation?.status, c.api]);

  const mentionsBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const notice of c.noticeList) if (notice.channel_id) counts.set(notice.channel_id, (counts.get(notice.channel_id) ?? 0) + 1);
    return counts;
  }, [c.noticeList]);

  // Report this host's picker rows to the shared directory.
  const label = hostLabel(host);
  const rows = useMemo(() => c.servers.map(server => ({
    key: `${host.id}:${server.id}`, name: server.name, host: label,
    status: c.online ? "connected" as const : "reconnecting" as const,
    mentions: c.channels.filter(channel => channel.server_id === server.id).reduce((sum, channel) => sum + (mentionsBy.get(channel.id) ?? 0), 0),
  })), [c.servers, c.channels, c.online, mentionsBy, host.id, label]);
  const rowsKey = JSON.stringify(rows);
  useEffect(() => {
    hosts.directory.report(host.id, { signedIn: !!me, servers: rows });
  }, [rowsKey, !!me, host.id, hosts.directory]);
  useEffect(() => () => hosts.directory.report(host.id), [host.id, hosts.directory]);

  // A picker row on this host was chosen while another host was active.
  useEffect(() => {
    if (!isActive || !me) return;
    const wanted = hosts.directory.take(host.id);
    const server = wanted && c.servers.find(candidate => candidate.id === wanted);
    if (server) { setServerId(server.id); void c.run(() => c.select(server.general_channel_id)); }
  }, [isActive, !!me, c.servers.length]);

  const nameOf = (id: string) => c.members.find(member => member.id === id)?.username ?? id;
  const view = (message: Message, visible: readonly Message[]): ChatMessage => {
    const details = messageDetails(message, me?.id ?? "", nameOf, visible);
    let nodes: ChatMessage["nodes"] = [];
    try { nodes = markdownTokens(message.body); } catch { nodes = [{ kind: "text", text: message.body }]; }
    const mine = message.author_id === me?.id;
    return {
      id: message.id, authorId: message.author_id, authorName: details.authorName, body: message.body, nodes,
      createdAt: message.created_at, editedAt: details.editedAt, pinned: details.pinned,
      replyTo: details.replyTo ?? null, reactions: details.reactions, mentionsMe: details.mentionsMe && !mine,
      attachments: details.attachments.map(a => ({ id: a.id, filename: a.filename, size: a.length, video: !!a.videoPath })),
      mine, canEdit: mine, canUnsend: mine || !!me?.is_owner,
      link: c.capabilities.embeds === true ? firstPreviewLink(message.body) : undefined,
      gifs: c.capabilities.giphy === true ? [...message.body.matchAll(GIF_LINK)].map(match => match[1]) : [],
    };
  };
  const messages = useMemo(() => c.messages.map(message => view(message, c.messages)), [c.messages, c.members, me?.id, c.capabilities]);

  const ask = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    let result: T | undefined;
    await c.run(async () => { result = await work(); });
    return result;
  };

  const people: Person[] = current && current.kind !== "channel"
    ? [...new Map([me!, ...c.members.filter(member => c.messages.some(message => message.author_id === member.id))].map(user => [user.id, person(user)])).values()]
    : serverPeople.map(person);

  const pending: PendingUpload | undefined = upload ? {
    filename: upload.filename, sent: upload.offset, total: upload.length,
    state: uploadError ? "failed" : upload.status === "ready" ? "ready" : upload.status === "quarantined" ? "held" : paused ? "paused" : "uploading",
    note: uploadError || (upload.status === "quarantined" ? uploadScanMessage(upload.scan) : undefined),
    canRetryScan: upload.status === "quarantined" && !(upload.scan?.verdict === "detected" || upload.scan?.verdict === "pending" || upload.scan?.reason === "engine_limit" || upload.scan?.reason === "encrypted_or_unsupported"),
    canPrepareVideo: upload.status === "ready" && c.capabilities.transcode === true && VIDEO_NAME.test(upload.filename) && !derivation,
    video: derivation ? { state: derivation.status as NonNullable<PendingUpload["video"]>["state"], error: derivation.error } : undefined,
  } : undefined;

  const transfer = async (existing?: Upload) => {
    const chosen = file.current;
    if (!chosen) return;
    setPaused(false); setUploadError("");
    try {
      const target = existing ?? await uploader.create(c.channel, chosen);
      const done = await uploader.resume(target.id, chosen);
      if (done.status === "ready")
        setAttached(previous => previous.some(item => item.id === done.id) ? previous : [...previous, { id: done.id, filename: done.filename }]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // 423 means the file is held by the scanner; the chip shows that state itself.
      if (!(error instanceof Error && "status" in error && error.status === 423)) setUploadError(error instanceof Error ? error.message : String(error));
    }
  };

  const servers: ServerEntry[] = hosts.hosts.flatMap(entry => (directory[entry.id]?.servers ?? []).map(row => ({
    ...row, current: entry.id === host.id && row.key === `${host.id}:${serverId}`,
  })));

  const post = async (body: string) => {
    const latestMembers = await c.api.get<{ members: User[] }>("/api/members");
    const latestRoles = channelServer ? (await c.api.get<{ roles: Role[] }>(`/api/servers/${channelServer}/roles`)).roles : [];
    return {
      body, mention_ids: mentionedUsers(body, latestMembers.members), role_mention_ids: mentionedRoles(body, latestRoles),
    };
  };

  const store: ChatStore = {
    online: c.online, busy: c.busy, error: c.error,
    me: me ? person(me) : { id: "", name: "", owner: false },
    servers,
    conversations: c.channels
      .filter(channel => channel.kind !== "channel" || channel.server_id === serverId)
      .map(channel => ({ id: channel.id, name: channel.name, kind: kindOf(channel), mentions: mentionsBy.get(channel.id) ?? 0 })),
    current: current ? { id: current.id, name: current.name, kind: kindOf(current), mentions: mentionsBy.get(current.id) ?? 0 } : undefined,
    people, friends: serverPeople.map(person), messages,
    typing: c.typers.map(nameOf),
    requests: c.gimmeRequests.map((request): RequestCard => ({
      id: request.id, title: request.result?.title ?? request.request.query, media: request.request.media,
      status: gimmeStatusText(request), requestedBy: nameOf(request.user_id),
    })),
    draft,
    replyingTo: reply ? messages.find(message => message.id === reply) : undefined,
    editing: editing ? messages.find(message => message.id === editing.id) : undefined,
    suggestions: [
      ...mentionCandidates(draft, c.members).map((member): Suggestion => ({ id: member.id, label: member.username, kind: "person" })),
      ...roleCandidates(draft, roles).map((role): Suggestion => ({ id: role.id, label: role.name, kind: "role" })),
    ],
    attached, upload: pending,
    can: { attach: c.capabilities.uploads === true, gif: c.capabilities.giphy === true, createChannel: !!me?.is_owner },

    clearError: () => void c.run(async () => {}),
    selectServer: async key => {
      const [hostId, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (hostId !== host.id) { hosts.directory.want(hostId, id); hosts.setActive(hostId); return; }
      const server = c.servers.find(candidate => candidate.id === id);
      if (!server) return;
      setServerId(server.id);
      await c.run(() => c.select(server.general_channel_id));
    },
    open: id => c.run(async () => {
      setReply(undefined); setEditing(undefined);
      await c.select(id);
    }),
    setDraft: text => {
      setDraftState(text);
      if (text && c.channel && Date.now() - lastTyping.current > 3000) {
        lastTyping.current = Date.now();
        void c.api.post(`/api/channels/${c.channel}/typing`, { active: true }).catch(() => {});
      }
    },
    send: () => c.run(async () => {
      const body = draft.trim();
      if (!body && !attached.length) return;
      if (editing) await c.api.patch(`/api/messages/${editing.id}`, { body, revision: editing.revision });
      else await c.api.post(`/api/channels/${c.channel}/messages`, {
        ...(await post(body || attached.map(item => item.filename).join(", "))),
        reply_to: reply ?? null, attachment_ids: attached.map(item => item.id),
      });
      setReply(undefined); setEditing(undefined); setDraftState(""); setAttached([]);
      if (upload?.status === "ready") { setUpload(undefined); setDerivation(undefined); file.current = undefined; }
      lastTyping.current = 0;
      await c.api.post(`/api/channels/${c.channel}/typing`, { active: false });
      await c.refresh();
    }),
    cancelCompose: () => { setReply(undefined); setEditing(undefined); setDraftState(""); },
    reply: id => { setEditing(undefined); setReply(id); },
    edit: id => {
      const message = c.messages.find(candidate => candidate.id === id);
      if (message) { setReply(undefined); setEditing(message); setDraftState(message.body); }
    },
    complete: suggestion => setDraftState(suggestion.kind === "person" ? completeMention(draft, suggestion.label) : completeRole(draft, suggestion.label)),
    react: (id, emoji) => c.run(async () => { await c.api.post(`/api/messages/${id}/reactions`, { emoji }); await c.refresh(); }),
    pin: id => c.run(async () => {
      const message = c.messages.find(candidate => candidate.id === id);
      await c.api.post(`/api/messages/${id}/pin`, { pinned: !message?.pinned });
      await c.refresh();
    }),
    unsend: id => c.run(async () => {
      await c.api.delete(`/api/messages/${id}`);
      c.store.retract(id); c.notifications.retract(id);
      await c.refresh();
    }),
    preview: id => ask<LinkPreview | undefined>(async () => {
      const url = firstPreviewLink(c.messages.find(message => message.id === id)?.body ?? "");
      return url ? previewLink(c.api, url) : undefined;
    }),
    markRead: async () => {
      const last = c.messages.at(-1);
      if (!last || !mentionsBy.get(c.channel)) return;
      await c.run(async () => { await c.api.post(`/api/channels/${c.channel}/read`, { message_id: last.id }); await c.refresh(); });
    },
    search: async query => (await ask(async () => {
      const found = (await c.api.get<{ messages: Message[] }>(`/api/channels/${c.channel}/messages?q=${encodeURIComponent(query)}`)).messages.filter(message => !c.store.isDeleted(message.id));
      return found.map(message => view(message, found));
    })) ?? [],
    pins: async () => (await ask(async () => {
      const found = (await c.api.get<{ messages: Message[] }>(`/api/channels/${c.channel}/messages?pinned=true`)).messages.filter(message => !c.store.isDeleted(message.id));
      return found.map(message => view(message, found));
    })) ?? [],
    attach: async chosen => {
      uploader.pause();
      file.current = chosen;
      setUpload(undefined); setDerivation(undefined);
      await transfer();
    },
    pauseUpload: () => { uploader.pause(); setPaused(true); },
    resumeUpload: () => transfer(upload),
    discardUpload: () => {
      uploader.pause();
      if (upload) { setAttached(previous => previous.filter(item => item.id !== upload.id)); if (upload.status !== "ready") void c.api.delete(`/api/uploads/${upload.id}`).catch(() => {}); }
      file.current = undefined; setUpload(undefined); setDerivation(undefined); setPaused(false); setUploadError("");
    },
    checkScan: async () => {
      if (!upload) return;
      try {
        const refreshed = await uploader.refreshScan(upload.id);
        if (refreshed.status === "ready") setAttached(previous => previous.some(item => item.id === refreshed.id) ? previous : [...previous, { id: refreshed.id, filename: refreshed.filename }]);
      } catch (error) { setUploadError(error instanceof Error ? error.message : String(error)); }
    },
    retryScan: async () => {
      if (upload?.status !== "quarantined") return;
      try {
        const done = await uploader.retryScan(upload.id);
        if (done.status === "ready") setAttached(previous => previous.some(item => item.id === done.id) ? previous : [...previous, { id: done.id, filename: done.filename }]);
      } catch { /* the chip shows the scanner state the server reported */ }
    },
    prepareVideo: () => c.run(async () => { if (upload?.status === "ready") setDerivation(await c.api.post(`/api/uploads/${upload.id}/derive`, {})); }),
    removeAttached: id => setAttached(previous => previous.filter(item => item.id !== id)),
    searchGifs: async query => (await ask(async () => (await c.api.get<{ results: Gif[] }>(`/api/giphy/search?q=${encodeURIComponent(query)}`)).results.map(({ id, title }) => ({ id, title })))) ?? [],
    sendGif: gif => c.run(async () => {
      await c.api.post(`/api/channels/${c.channel}/messages`, { ...(await post(`https://giphy.com/gifs/${gif.id}`)), reply_to: reply ?? null, attachment_ids: [] });
      setReply(undefined);
      await c.refresh();
    }),
    gifSource: id => {
      let pending = gifCache.current.get(id);
      if (!pending) {
        pending = fetch(c.api.mediaRequest(`/api/giphy/media/${encodeURIComponent(id)}`)).then(async response => {
          if (!response.ok) throw new Error(`GIF unavailable (${response.status})`);
          return URL.createObjectURL(await response.blob());
        });
        pending.catch(() => gifCache.current.delete(id));
        gifCache.current.set(id, pending);
      }
      return pending;
    },
    download: (attachment: Attachment) => c.run(async () => {
      const response = await fetch(c.api.mediaRequest(`/api/media/${encodeURIComponent(attachment.id)}`));
      if (!response.ok) throw new Error(`File unavailable (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = attachment.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
    playVideo: (element, messageId, attachmentId, onError) => {
      const path = c.messages.find(message => message.id === messageId)?.attachments?.find(item => item.id === attachmentId)?.video_path;
      if (!path) { onError("Video unavailable"); return () => {}; }
      const player = new UploadedVideo(element, c.api, onError);
      void player.load(path);
      return () => player.destroy();
    },
    startDirect: (memberIds, name) => c.run(async () => {
      const title = name.trim() || memberIds.map(nameOf).join(", ");
      const created = await c.api.post<{ id: string }>("/api/channels", { name: title, kind: memberIds.length > 1 ? "group_dm" : "dm", member_ids: memberIds });
      await c.refresh();
      await c.select(created.id);
    }),
    createChannel: (name, memberIds) => c.run(async () => {
      const created = await c.api.post<{ id: string }>("/api/channels", { name, kind: "channel", server_id: serverId, member_ids: memberIds });
      await c.refresh();
      await c.select(created.id);
    }),
  };
  return { store, serverId, roles, setRoles };
}
