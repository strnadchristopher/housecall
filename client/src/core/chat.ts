/**
 * ChatStore: everything the UI needs to show and change conversations.
 * Components depend on this interface only; adapters/legacy implements it on
 * the current REST backend and adapters/e2ee will replace it later.
 * No transport types (Api, sessions, URLs, tokens) may appear here.
 */
import type { MarkdownNode } from "./markdown";

export interface Person {
  id: string;
  name: string;
  owner: boolean;
}

/** One picker row: a server on a connected host. */
export interface ServerEntry {
  key: string;
  name: string;
  /** Host label (for example chat.example.com). Shown only when more than one host is connected. */
  host: string;
  status: "connected" | "reconnecting";
  mentions: number;
  current: boolean;
}

export interface Conversation {
  id: string;
  name: string;
  kind: "channel" | "dm" | "group";
  mentions: number;
}

export interface Attachment {
  id: string;
  filename: string;
  size: string;
  video: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  nodes: MarkdownNode[];
  createdAt: number;
  editedAt?: number;
  pinned: boolean;
  replyTo: { id: string; authorName: string; excerpt: string } | null;
  reactions: Reaction[];
  mentionsMe: boolean;
  attachments: Attachment[];
  mine: boolean;
  canEdit: boolean;
  canUnsend: boolean;
  /** First https link in the body, when a preview can be requested. */
  link?: string;
  /** GIF ids referenced by the body (rendered inline when the server can serve them). */
  gifs: string[];
}

export interface LinkPreview {
  url: string;
  hostname: string;
  title: string;
  description: string;
}

export interface Suggestion {
  id: string;
  label: string;
  kind: "person" | "role";
}

export interface PendingUpload {
  filename: string;
  sent: string;
  total: string;
  state: "uploading" | "paused" | "held" | "ready" | "failed";
  /** Scanner or transfer message when state is held or failed. */
  note?: string;
  canRetryScan: boolean;
  canPrepareVideo: boolean;
  video?: { state: "queued" | "running" | "ready" | "failed"; error?: string };
}

export interface Gif {
  id: string;
  title: string;
}

/** A Gimme request shown in the conversation. */
export interface RequestCard {
  id: string;
  title: string;
  media: "movie" | "tv";
  status: string;
  requestedBy: string;
}

export interface ChatState {
  online: boolean;
  busy: boolean;
  /** The current conversation's first page has not arrived yet. */
  loading: boolean;
  error: string;
  me: Person;
  servers: ServerEntry[];
  conversations: Conversation[];
  current?: Conversation;
  /** Members of the current conversation's server. The backend reports no presence. */
  people: Person[];
  /** Everyone on this server you can message or add to a channel. */
  friends: Person[];
  messages: ChatMessage[];
  typing: string[];
  requests: RequestCard[];
  draft: string;
  replyingTo?: ChatMessage;
  editing?: ChatMessage;
  suggestions: Suggestion[];
  attached: { id: string; filename: string }[];
  upload?: PendingUpload;
  can: { attach: boolean; gif: boolean; createChannel: boolean };
}

export interface ChatStore extends ChatState {
  clearError(): void;
  selectServer(key: string): Promise<void>;
  open(conversationId: string): Promise<void>;
  setDraft(text: string): void;
  send(): Promise<void>;
  cancelCompose(): void;
  reply(messageId: string): void;
  edit(messageId: string): void;
  complete(suggestion: Suggestion): void;
  react(messageId: string, emoji: string): Promise<void>;
  pin(messageId: string): Promise<void>;
  unsend(messageId: string): Promise<void>;
  preview(messageId: string): Promise<LinkPreview | undefined>;
  markRead(): Promise<void>;
  search(query: string): Promise<ChatMessage[]>;
  pins(): Promise<ChatMessage[]>;
  attach(file: File): Promise<void>;
  pauseUpload(): void;
  resumeUpload(): Promise<void>;
  discardUpload(): void;
  checkScan(): Promise<void>;
  retryScan(): Promise<void>;
  prepareVideo(): Promise<void>;
  removeAttached(id: string): void;
  searchGifs(query: string): Promise<Gif[]>;
  /** Sends the GIF as its own message. */
  sendGif(gif: Gif): Promise<void>;
  /** Object URL for an authenticated GIF clip (mp4). */
  gifSource(id: string): Promise<string>;
  /** Saves an attachment to the device. */
  download(attachment: Attachment): Promise<void>;
  /** Binds a scanned video attachment to a player element; returns a disposer. */
  playVideo(element: HTMLVideoElement, messageId: string, attachmentId: string, onError: (message: string) => void): () => void;
  /** These resolve to whether the request succeeded; callers navigate or clear forms only on success. */
  startDirect(memberIds: string[], name: string): Promise<boolean>;
  createChannel(name: string, memberIds: string[]): Promise<boolean>;
}
