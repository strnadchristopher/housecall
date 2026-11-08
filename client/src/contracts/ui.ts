import type { MarkdownNode } from "../data/markdown";
export type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'offline' | 'forbidden' | 'unavailable';
export type ScreenId = 'setup' | 'invite' | 'login' | 'shell' | 'conversation' | 'composer' | 'thread' | 'search' | 'pins' | 'members' | 'direct-messages' | 'uploads' | 'media' | 'gifs' | 'voice' | 'activities' | 'plex' | 'dj' | 'vm' | 'gimme' | 'notifications' | 'settings' | 'devices' | 'invites-admin' | 'report' | 'reports-admin' | 'servers-admin' | 'channels-admin' | 'roles-admin';
export interface Field { name: string; label: string; type?: 'text' | 'email' | 'password' | 'number' | 'checkbox' | 'file'; value?: string; required?: boolean }
export interface Action { id: string; label: string; disabled?: boolean }
export interface MessageDetails {
  authorId: string; authorName: string; createdAt: number; editedAt?: number;
  replyTo?: { id: string; authorName: string; excerpt: string } | null;
  pinned: boolean; reactions: { emoji: string; count: number; mine: boolean }[];
  attachments: { id: string; filename: string; length: string; videoPath?: string; thumbnailPath?: string }[];
  mentionsMe: boolean;
}
export interface Item {
  id: string; text: string; richText?: MarkdownNode[]; actions?: Action[];
  message?: MessageDetails;
  uploadScan?: import("../transport/uploads").UploadScan | null;
  channel?: { kind: 'channel' | 'dm' | 'group_dm'; serverId?: string; current: boolean; unread?: number; mentions?: number };
  activity?: { duration_ms: number | null; media_id: string | null; hostName: string; controller_expires_at?: number; isHost: boolean; canStop: boolean };
  queue?: { requested_by: string; votedToSkip: boolean };
}
export interface Intent { screen: ScreenId; action: string; itemId?: string; values: Record<string, string | boolean> }
export interface ScreenProps {
  id: ScreenId; title: string; phase: Phase; error?: string; busy?: boolean;
  fields?: Field[]; items?: Item[]; actions?: Action[]; submitLabel?: string;
  attachments?: { id: string; filename: string }[];
  vm?: { configured: boolean; armed: boolean; phase: string; peerId?: string; streamIds: string[]; reset?: { phase: "confirm" | "running" | "retry"; message?: string } };
  voice?: { inputs: { id: string; label: string; kind: 'audioinput' | 'videoinput' }[];
    selected: { microphone?: string; camera?: string } };
  onIntent: (intent: Intent) => Promise<void>;
}
export interface Capability { available: boolean; reason?: string }
export interface AudioPreferences { bitrate: number; stereo: boolean; fullband: boolean; noiseSuppression: boolean }
export const defaultAudio: AudioPreferences = { bitrate: 510000, stereo: true, fullband: true, noiseSuppression: false };
