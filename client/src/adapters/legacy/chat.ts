import { securitySession, securityUpdates } from "./securityRuntime";
import type { DmContext, OpenedDmMessage } from "../../core/dm";
import type { FileRef } from "../../crypto/dm";
import { copy } from "../../ui/copy";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ChatMessage, ChatStore, Conversation, Gif, LinkPreview, PendingUpload, Person, RequestCard, ServerEntry, Suggestion } from "../../core/chat";
import type { useHousecall } from "../../hooks/useHousecall";
import type { Message } from "../../state/messages";
import type { Channel, Role, User } from "../../data/types";
import { markdownTokens } from "../../data/markdown";
import { messageDetails } from "../../data/messageView";
import { firstPreviewLink, previewLink } from "../../data/embeds";
import { gimmeStatusText } from "../../data/gimme";
import { avatarPath, iconPath, userName } from "../../data/people";
import { completeMention, completeRole, mentionCandidates, mentionedRoles, mentionedUsers, roleCandidates } from "../../data/mentions";
import { ResumableUpload, uploadScanMessage, type Upload } from "../../transport/uploads";
import { UploadedVideo } from "../../transport/video";
import type { HostEntry, HostReport, Hosts } from "./hosts";

export type Housecall = ReturnType<typeof useHousecall>;

const GIF_LINK = /https:\/\/giphy\.com\/gifs\/([A-Za-z0-9]{1,64})(?![A-Za-z0-9])/g;
const SNAP_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEO_NAME =/\.(mp4|m4v|mov|mkv|webm|avi)$/i;

export const person = (user: User): Person => ({ id: user.id, name: userName(user), username: user.username, owner: user.is_owner, avatarUrl: avatarPath(user), bio: user.bio ?? undefined });

/** The signed-in user as the server last reported them, so a changed display name or avatar shows at once. */
export const currentUser = (c: Pick<Housecall, "auth" | "members">): User | undefined =>
  c.auth ? c.members.find(member => member.id === c.auth!.user.id) ?? c.auth.user : undefined;

function kindOf(channel: Channel): Conversation["kind"] {
  return channel.kind === "channel" || channel.kind === "voice" ? channel.kind : channel.kind === "dm" ? "dm" : "group";
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
  const meUser = currentUser(c);
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
  // Snaps upload on their own so a snap never touches a file the person is attaching.
  const snapUploader = useMemo(() => new ResumableUpload(c.api, () => {}), [c.api]);

  const current = c.channels.find(channel => channel.id === c.channel);
  const channelServer = current?.server_id ?? undefined;
  const origin = c.api.serverOrigin();
  const session = me ? securitySession(c.api, origin, me.id) : undefined;
  const bindings = session?.dm.conversations;
  const boundDm = !!bindings?.isDm(c.channel);
  const invalidDm = boundDm && !bindings?.valid(c.channel);
  const dmContext: DmContext | undefined = bindings?.context(c.channel);
  const assertConversation = () => bindings?.assert(c.channel);
  const [securityVersion, bumpSecurity] = useState(0);
  type DmReadiness = Awaited<ReturnType<NonNullable<typeof session>['dm']['security']>>;
  const [removedAcknowledged, setRemovedAcknowledged] = useState<{ session: typeof session; channel: string }>();
  const [dmReadiness, setDmReadiness] = useState<{ session: typeof session; channel: string; value: DmReadiness }>();
  const dmSecurity = !invalidDm && dmReadiness?.session === session && dmReadiness?.channel === c.channel ? dmReadiness.value : undefined;
  const setDmSecurity = (value?: DmReadiness) => setDmReadiness(value ? { session, channel: c.channel, value } : undefined);
  const [openedState, setOpened] = useState<{ session: typeof session; rows: typeof c.messages; channel: string; value: Map<string, OpenedDmMessage> }>();
  const opened = openedState?.session === session && openedState?.rows === c.messages && openedState?.channel === c.channel ? openedState.value : new Map<string, OpenedDmMessage>();
  const sealedFiles = useRef<FileRef[]>([]);
  const sensitiveBuffers = useRef(new Set<Uint8Array>());
  const sensitiveRequests = useRef(new Set<AbortController>());
  const [sealedUpload, setSealedUpload] = useState<PendingUpload>();
  const composeEpoch = useRef(0);
  const previousDm = useRef(false);
  const downloadUrls = useRef(new Set<string>());
  const secure = boundDm && (!dmSecurity || dmSecurity.peer.state !== 'NONE');
  useEffect(() => securityUpdates.subscribe(() => bumpSecurity(n => n + 1)), []);
  useEffect(() => {
    let alive = true;
    setDmSecurity(undefined); setOpened(undefined);
    if (session && dmContext && !invalidDm) void (async () => {
      await session.dm.security(dmContext);
      const value = await session.dm.openHistory(dmContext, c.messages);
      // Envelope-triggered refresh may have changed the peer state.
      const latest = await session.dm.security(dmContext);
      if (alive) { setDmSecurity(latest); setOpened({ session, rows: c.messages, channel: c.channel, value }); }
    })().catch(error => { if (alive) { setDmSecurity(undefined); void c.run(async () => { throw error; }); } });
    return () => { alive = false; };
  }, [session, c.channel, c.messages, securityVersion, invalidDm, current?.peer_id]);
  useLayoutEffect(() => {
    if (previousDm.current) { setDraftState(""); setEditing(undefined); setReply(undefined); }
    previousDm.current = !!dmContext;
    composeEpoch.current++; sealedFiles.current = []; setAttached([]); setSealedUpload(undefined);
    for (const buffer of sensitiveBuffers.current) buffer.fill(0); sensitiveBuffers.current.clear();
    for (const request of sensitiveRequests.current) request.abort(); sensitiveRequests.current.clear();
    for (const url of downloadUrls.current) URL.revokeObjectURL(url); downloadUrls.current.clear();
    return () => { composeEpoch.current++; for (const buffer of sensitiveBuffers.current) buffer.fill(0); sensitiveBuffers.current.clear(); for (const request of sensitiveRequests.current) request.abort(); sensitiveRequests.current.clear(); for (const url of downloadUrls.current) URL.revokeObjectURL(url); downloadUrls.current.clear(); };
  }, [session, c.channel, current?.kind]);

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
    key: `${host.id}:${server.id}`, name: server.name, iconUrl: iconPath(server), host: label,
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

  const nameOf = (id: string) => { const member = c.members.find(candidate => candidate.id === id); return member ? userName(member) : id; };
  const avatarOf = (id: string) => { const member = c.members.find(candidate => candidate.id === id); return member ? avatarPath(member) : undefined; };
  const fetchMedia = async (path: string): Promise<Blob> => {
    const response = await fetch(c.api.mediaRequest(path));
    if (!response.ok) throw new Error(`File unavailable (${response.status})`);
    return response.blob();
  };
  const view = (message: Message, visible: readonly Message[]): ChatMessage => {
    const raw = message;
    const encrypted = (row: Message) => row.enc === 1;
    const source = c.messages.find(row => row.id === raw.id);
    const state = dmContext && raw.channel_id === dmContext.id && source?.envelope === raw.envelope && source?.author_id === raw.author_id ? opened.get(raw.id) : undefined;
    // Decrypted payloads enter this typed presentation path only, never the legacy store or its consumers.
    if (encrypted(raw)) {
      const body = state?.status === 'opened' ? state.payload.text : state?.status === 'old-own-key' ? copy.e2e.oldOwnKey : state?.status === 'unchecked-peer-key' ? copy.e2e.uncheckedPeerKey : state?.status === 'unsupported' ? copy.e2e.unsupported : state?.status === 'locked' || !state ? session?.identity.vault.native ? copy.e2e.sealed : copy.e2e.lockedBrowser : copy.e2e.undecryptable;
      message = { ...raw, body, attachments: [], reply_to: null };
    }
    visible = visible.map(row => encrypted(row) ? { ...row, body: '', attachments: [], reply_to: null } : row);
    const details = messageDetails(message, me?.id ?? "", nameOf, visible);
    let nodes: ChatMessage["nodes"] = [];
    try { nodes = markdownTokens(message.body); } catch { nodes = [{ kind: "text", text: message.body }]; }
    const mine = message.author_id === me?.id;
    let authenticatedReply: ChatMessage['replyTo'] = null;
    if (state?.status === 'opened' && state.reply === 'authenticated' && raw.reply_to) {
      const target = c.messages.find(row => row.id === raw.reply_to), targetOpen = opened.get(raw.reply_to);
      if (target && targetOpen?.status === 'opened') authenticatedReply = { id: target.id, authorName: nameOf(target.author_id), excerpt: targetOpen.payload.text };
    }
    const sealed = state?.status === 'opened' ? (state.payload.files ?? []).map(f => ({ id: f.id, filename: f.name, size: String(f.size), kind: 'file' as const, video: false, sealed: true })) : undefined;
    return {
      plaintextMarker: !!dmContext && raw.enc !== 1 && !!dmSecurity?.peer.pin,
      security: state ?? (encrypted(raw) ? { status: 'locked', encrypted: false } : undefined),
      id: message.id, authorId: message.author_id, authorName: details.authorName, authorAvatarUrl: avatarOf(message.author_id), body: message.body, nodes,
      createdAt: message.created_at, editedAt: details.editedAt, pinned: details.pinned,
      replyTo: encrypted(raw) ? authenticatedReply : secure ? null : details.replyTo ?? null, reactions: details.reactions, mentionsMe: details.mentionsMe && !mine,
      attachments: sealed ?? details.attachments.filter(a => !raw.attachments?.some(original => original.id === a.id && original.kind === 'sealed')).map(a => ({ id: a.id, filename: a.filename, size: a.length, kind: a.kind as Attachment["kind"], video: !!a.videoPath, thumbnail: a.thumbnailPath, snap: a.snap })),
      mine, canEdit: mine && (encrypted(raw) ? state?.status === 'opened' : !secure), canUnsend: mine || !!me?.is_owner,
      link: !secure && !encrypted(raw) && c.capabilities.embeds === true ? firstPreviewLink(message.body) : undefined,
      gifs: !secure && !encrypted(raw) && c.capabilities.giphy === true ? [...message.body.matchAll(GIF_LINK)].map(match => match[1]) : [],
    };
  };
  const messages = useMemo(() => c.messages.filter(message => (!dmContext || message.enc !== 1 || opened.has(message.id)) && !["held", "duplicate"].includes(opened.get(message.id)?.status ?? "")).map(message => view(message, c.messages)), [c.messages, c.members, me?.id, c.capabilities, openedState, secure]);

  const ask = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    let result: T | undefined;
    await c.run(async () => { result = await work(); });
    return result;
  };

  const people: Person[] = current && current.kind !== "channel" && current.kind !== "voice"
    // Both people of a direct conversation, whoever has posted: the Call button and People tab need the peer.
    ? [...new Map([meUser!, ...c.members.filter(member => member.id === current.peer_id || c.messages.some(message => message.author_id === member.id))].map(user => [user.id, person(user)])).values()]
    : serverPeople.map(person);

  const pending: PendingUpload | undefined = upload ? {
    filename: upload.filename, sent: upload.offset, total: upload.length,
    state: uploadError ? "failed" : upload.status === "ready" ? "ready" : upload.status === "quarantined" ? "held" : paused ? "paused" : "uploading",
    note: uploadError || (upload.status === "quarantined" ? uploadScanMessage(upload.scan) : undefined),
    canRetryScan: upload.status === "quarantined" && !(upload.scan?.verdict === "detected" || upload.scan?.verdict === "pending" || upload.scan?.reason === "engine_limit" || upload.scan?.reason === "encrypted_or_unsupported"),
    canPrepareVideo: upload.status === "ready" && c.capabilities.transcode === true && VIDEO_NAME.test(upload.filename) && !derivation,
    video: derivation ? { state: derivation.status as NonNullable<PendingUpload["video"]>["state"], error: derivation.error } : undefined,
  } : undefined;

  const discardLegacyUpload = (target = upload) => {
    uploader.pause(); file.current = undefined;
    if (target) {
      setAttached(previous => previous.filter(item => item.id !== target.id));
      void c.api.delete(`/api/uploads/${target.id}`).catch(() => {});
    }
    setUpload(undefined); setDerivation(undefined); setPaused(false); setUploadError("");
  };
  useEffect(() => {
    if (file.current && boundDm && dmSecurity && !dmSecurity.peer.canSendPlaintext) {
      discardLegacyUpload();
      void c.run(async () => { throw new Error(copy.security.reattachEncrypted); });
    }
  }, [boundDm, dmSecurity?.peer.canSendPlaintext]);

  const transfer = async (existing?: Upload) => {
    const chosen = file.current;
    if (!chosen) return;
    setPaused(false); setUploadError("");
    const epoch = composeEpoch.current;
    let target = existing;
    try {
      assertConversation();
      const permit = async <T,>(send: () => Promise<T>): Promise<T> => {
        assertConversation();
        if (chosen !== file.current || epoch !== composeEpoch.current) throw new DOMException('Upload discarded', 'AbortError');
        if (!boundDm) return send();
        if (!session || !dmContext) throw new Error(copy.security.reattachEncrypted);
        let sending = false;
        try { return await session.dm.withLegacyPlaintext(dmContext, () => {
          sending = true;
          if (chosen !== file.current || epoch !== composeEpoch.current) throw new DOMException('Upload discarded', 'AbortError');
          return send();
        }); }
        catch (error) {
          if (!sending) {
            discardLegacyUpload(target);
            await c.run(async () => { throw new Error(copy.security.reattachEncrypted); });
          }
          throw error;
        }
      };
      // Resume and every subsequent chunk use current durable trust, never render-time readiness.
      target = existing ?? await uploader.create(c.channel, chosen, permit);
      const done = await uploader.resume(target.id, chosen, permit);
      if (done.status === "ready")
        setAttached(previous => previous.some(item => item.id === done.id) ? previous : [...previous, { id: done.id, filename: done.filename }]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // 423 means the file is held by the scanner; the chip shows that state itself.
      if (!(error instanceof Error && "status" in error && error.status === 423)) setUploadError(error instanceof Error ? error.message : String(error));
    }
  };

  const servers: ServerEntry[] = hosts.hosts.flatMap(entry => (directory[entry.id]?.servers ?? []).map(row => ({
    // Icons are fetched with this host's session, so rows from other hosts show initials.
    ...row, iconUrl: entry.id === host.id ? row.iconUrl : undefined, current: entry.id === host.id && row.key === `${host.id}:${serverId}`,
  })));

  const post = async (body: string) => {
    const latestMembers = await c.api.get<{ members: User[] }>("/api/members");
    const latestRoles = channelServer ? (await c.api.get<{ roles: Role[] }>(`/api/servers/${channelServer}/roles`)).roles : [];
    return {
      body, mention_ids: mentionedUsers(body, latestMembers.members), role_mention_ids: mentionedRoles(body, latestRoles),
    };
  };

  const store: ChatStore = {
    retrySecurity: () => bumpSecurity(n => n + 1),
    heldMessages: [...opened.values()].filter(row => row.status === 'held').length,
    dmSecurity: boundDm ? dmSecurity ? { ...dmSecurity, removalAcknowledged: removedAcknowledged?.session === session && removedAcknowledged?.channel === c.channel && dmSecurity.peer.state === 'CHANGED_UNACKNOWLEDGED' && !dmSecurity.peer.candidate } : { label: 'not-encrypted', canSend: false, peer: { state: 'NONE', canAcknowledge: false, canSendEncrypted: false, canSendPlaintext: false } } : undefined,
    acknowledgeKey: async () => { if (session && dmContext) await c.run(async () => { const next = await session.dm.acknowledgeChange(dmContext.memberIds[1]); if (next.state === 'CHANGED_UNACKNOWLEDGED' && !next.candidate) setRemovedAcknowledged({ session, channel: c.channel }); securityUpdates.emit(); }); },
    safetyNumber: () => session && dmContext ? session.dm.safety(dmContext.memberIds[1]) : Promise.resolve(undefined),
    verifySafety: number => c.run(async () => { if (session && dmContext) { try { await session.dm.markVerified(dmContext.memberIds[1], number); } finally { securityUpdates.emit(); } } }),
    online: c.online, busy: c.busy, loading: c.loading, error: c.error,
    me: meUser ? person(meUser) : { id: "", name: "", username: "", owner: false },
    servers,
    conversations: c.channels
      .filter(channel => (channel.kind !== "channel" && channel.kind !== "voice") || channel.server_id === serverId)
      .map(channel => ({ id: channel.id, name: channel.name, kind: kindOf(channel), mentions: mentionsBy.get(channel.id) ?? 0, peerId: channel.peer_id ?? undefined })),
    current: current ? { id: current.id, name: current.name, kind: kindOf(current), mentions: mentionsBy.get(current.id) ?? 0, peerId: current.peer_id ?? undefined } : undefined,
    people, friends: serverPeople.map(person), messages,
    typing: c.typers.map(nameOf),
    requests: c.gimmeRequests.map((request): RequestCard => ({
      id: request.id, title: request.result?.title ?? request.request.query, media: request.request.media,
      status: gimmeStatusText(request), requestedBy: nameOf(request.user_id),
    })),
    draft,
    replyingTo: reply ? messages.find(message => message.id === reply) : undefined,
    editing: editing ? messages.find(message => message.id === editing.id) : undefined,
    suggestions: secure ? [] : [
      ...mentionCandidates(draft, c.members).map((member): Suggestion => ({ id: member.id, label: member.username, kind: "person" })),
      ...roleCandidates(draft, roles).map((role): Suggestion => ({ id: role.id, label: role.name, kind: "role" })),
    ],
    attached, upload: sealedUpload ?? pending,
    can: { attach: c.capabilities.uploads === true, gif: !secure && c.capabilities.giphy === true, createChannel: !!me?.is_owner },

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
      if (dmContext) setDraftState("");
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
      assertConversation();
      const body = draft.trim();
      if (!body && !attached.length) return;
      const readiness = dmContext && session ? await session.dm.security(dmContext) : undefined;
      if (dmContext && readiness && !readiness.canSend) throw new Error(copy.e2e.noteSetUp);
      if (dmContext && session && (!readiness?.peer.canSendPlaintext || (!editing && !reply && !attached.length))) {
        if (attached.length !== sealedFiles.current.length) throw new Error(copy.security.reattachEncrypted);
        const targetId = editing?.reply_to ?? reply;
        const targetRow = c.messages.find(row => row.id === targetId), targetOpened = targetId ? opened.get(targetId) : undefined;
        const bound = targetRow && targetOpened ? { row: targetRow, opened: targetOpened } : undefined;
        if (targetId && !bound) throw new Error(copy.e2e.replyUnchecked);
        if (editing) {
          const original = opened.get(editing.id);
          if (original?.status !== 'opened') throw new Error(copy.e2e.undecryptable);
          await session.dm.edit(dmContext, editing, { v: 1, text: body, files: original.payload.files }, bound);
        } else await session.dm.send(dmContext, body, sealedFiles.current, bound);
      } else if (dmContext && session) {
        const request = { ...(await post(body || attached.map(item => item.filename).join(', '))), reply_to: reply ?? null, attachment_ids: attached.map(item => item.id), ...(editing ? { revision: editing.revision } : {}) };
        await session.dm.sendLegacyPlaintext(dmContext, request, editing?.id);
      } else if (editing) await c.api.patch(`/api/messages/${editing.id}`, { body, revision: editing.revision });
      else await c.api.post(`/api/channels/${c.channel}/messages`, {
        ...(await post(body || attached.map(item => item.filename).join(", "))),
        reply_to: reply ?? null, attachment_ids: attached.map(item => item.id),
      });
      setReply(undefined); setEditing(undefined); setDraftState(""); setAttached([]); sealedFiles.current = [];
      if (upload?.status === "ready") { setUpload(undefined); setDerivation(undefined); file.current = undefined; }
      lastTyping.current = 0;
      await c.api.post(`/api/channels/${c.channel}/typing`, { active: false });
      await c.refresh();
    }),
    cancelCompose: () => { setReply(undefined); setEditing(undefined); setDraftState(""); },
    reply: id => { if (secure && opened.get(id)?.status !== 'opened') return; setEditing(undefined); setReply(id); },
    edit: id => {
      const message = c.messages.find(candidate => candidate.id === id);
      if (message) {
        const state = opened.get(id);
        if (message.enc === 1 && state?.status !== 'opened' || message.enc !== 1 && secure) return;
        setReply(undefined); setEditing(message); setDraftState(state?.status === 'opened' ? state.payload.text : message.body);
      }
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
      assertConversation();
      if (secure) return undefined;
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
      return found.filter(message => message.enc !== 1).map(message => view(message, found));
    })) ?? [],
    pins: async () => (await ask(async () => {
      const found = (await c.api.get<{ messages: Message[] }>(`/api/channels/${c.channel}/messages?pinned=true`)).messages.filter(message => !c.store.isDeleted(message.id));
      return found.map(message => view(message, found));
    })) ?? [],
    attach: async chosen => {
      if (bindings?.isDm(c.channel) && !bindings.valid(c.channel)) { await c.run(async () => assertConversation()); return; }
      if (dmContext && session && secure) {
        const epoch = composeEpoch.current;
        const controller = new AbortController(); sensitiveRequests.current.add(controller);
        setSealedUpload({ filename: chosen.name, sent: '0', total: String(chosen.size), state: 'uploading', canRetryScan: false, canPrepareVideo: false, encrypted: true });
        await c.run(async () => {
          const bytes = new Uint8Array(await chosen.arrayBuffer()); sensitiveBuffers.current.add(bytes);
          try {
            if (epoch !== composeEpoch.current || controller.signal.aborted) return;
            const ref = await session.dm.uploadAttachment(dmContext, bytes, chosen.name, chosen.type || 'application/octet-stream', controller.signal, (sent, total) => {
              if (epoch === composeEpoch.current) setSealedUpload({ filename: chosen.name, sent: String(sent), total: String(total), state: 'uploading', canRetryScan: false, canPrepareVideo: false, encrypted: true });
            });
            if (epoch !== composeEpoch.current) return;
            sealedFiles.current.push(ref); setAttached(previous => [...previous, { id: ref.id, filename: ref.name }]); setSealedUpload(undefined);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (epoch === composeEpoch.current) setSealedUpload({ filename: chosen.name, sent: '0', total: String(chosen.size), state: 'failed', note: copy.security.encryptedUploadFailed, canRetryScan: false, canPrepareVideo: false, encrypted: true });
            throw error;
          } finally { bytes.fill(0); sensitiveBuffers.current.delete(bytes); sensitiveRequests.current.delete(controller); }
        });
        return;
      }
      uploader.pause();
      file.current = chosen;
      setUpload(undefined); setDerivation(undefined);
      await transfer();
    },
    pauseUpload: () => { uploader.pause(); setPaused(true); },
    resumeUpload: () => transfer(upload),
    discardUpload: () => {
      composeEpoch.current++;
      for (const request of sensitiveRequests.current) request.abort(); sensitiveRequests.current.clear();
      for (const buffer of sensitiveBuffers.current) buffer.fill(0); sensitiveBuffers.current.clear();
      setSealedUpload(undefined);
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
    removeAttached: id => { sealedFiles.current = sealedFiles.current.filter(f => f.id !== id); setAttached(previous => previous.filter(item => item.id !== id)); },
    searchGifs: async query => (await ask(async () => (await c.api.get<{ results: Gif[] }>(`/api/giphy/search?q=${encodeURIComponent(query)}`)).results.map(({ id, title }) => ({ id, title })))) ?? [],
    sendGif: gif => c.run(async () => {
      assertConversation();
      if (secure) throw new Error(copy.e2e.off.gifs);
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
    fetchMedia,
    download: (attachment: Attachment) => c.run(async () => {
      const epoch = composeEpoch.current;
      let blob: Blob;
      let downloadName = attachment.filename;
      if (attachment.sealed) {
        const row = c.messages.find(row => row.attachments?.some(a => a.id === attachment.id));
        const state = row && opened.get(row.id);
        if (!session || !row || !state) throw new Error(copy.e2e.undecryptable);
        const controller = new AbortController(); sensitiveRequests.current.add(controller);
        try {
          const value = await session.dm.downloadAttachment(row, state, attachment.id, controller.signal);
          try { blob = new Blob([value.bytes.slice()], { type: value.mime }); downloadName = value.name; } finally { value.bytes.fill(0); }
        } finally { sensitiveRequests.current.delete(controller); }
      } else blob = await fetchMedia(`/api/media/${encodeURIComponent(attachment.id)}`);
      if (epoch !== composeEpoch.current) return;
      const url = URL.createObjectURL(blob); downloadUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url; link.download = downloadName; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 1000);
    }),
    sendSnap: photo => c.attempt(async () => {
      assertConversation();
      if (secure) throw new Error(copy.e2e.off.snaps);
      const extension = SNAP_TYPES[photo.type];
      if (!extension) throw new Error("Use a JPEG, PNG or WebP photo");
      // A neutral name: the camera's own file name is never sent.
      const file = new File([photo], `snap.${extension}`, { type: photo.type });
      const target = await snapUploader.create(c.channel, file);
      const done = await snapUploader.resume(target.id, file);
      if (done.status !== "ready") throw new Error(uploadScanMessage(done.scan));
      await c.api.post(`/api/channels/${c.channel}/messages`, { body: "", attachment_ids: [done.id], view_once: true });
      await c.refresh();
    }),
    openSnap: async id => {
      const response = await fetch(c.api.mediaRequest(`/api/snaps/${encodeURIComponent(id)}/open`, { method: "POST" }));
      if (response.status === 410) { await c.refresh(); return "gone"; }
      if (!response.ok) throw new Error(`Snap unavailable (${response.status})`);
      const photo = await response.blob();
      await c.refresh();
      return photo;
    },
    playVideo: (element, messageId, attachmentId, onError) => {
      const path = c.messages.find(message => message.id === messageId)?.attachments?.find(item => item.id === attachmentId)?.video_path;
      if (!path) { onError("Video unavailable"); return () => {}; }
      const player = new UploadedVideo(element, c.api, onError);
      void player.load(path);
      return () => player.destroy();
    },
    startDirect: (memberIds, name) => c.attempt(async () => {
      const title = name.trim() || memberIds.map(nameOf).join(", ");
      const created = await c.api.post<{ id: string }>("/api/channels", { name: title, kind: memberIds.length > 1 ? "group_dm" : "dm", member_ids: memberIds });
      await c.refresh();
      await c.select(created.id);
    }),
    createServer: async (name, icon) => {
      let result: { id: string; iconFailed: boolean } | undefined;
      await c.attempt(async () => {
        const created = await c.api.post<{ id: string; general_channel_id: string }>("/api/servers", { name });
        let iconFailed = false;
        if (icon) {
          try { await c.api.putBlob(`/api/servers/${encodeURIComponent(created.id)}/icon`, icon); } catch { iconFailed = true; }
        }
        result = { id: created.id, iconFailed };
        await c.refresh();
        setServerId(created.id);
        await c.select(created.general_channel_id);
      });
      return result;
    },
    createChannel: (name, memberIds, kind = "channel") => c.attempt(async () => {
      const created = await c.api.post<{ id: string }>("/api/channels", { name, kind, server_id: serverId, member_ids: memberIds });
      await c.refresh();
      await c.select(created.id);
    }),
  };
  return { store, serverId, roles, setRoles };
}
