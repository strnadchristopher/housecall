import type { MarkdownNode } from "../data/markdown";
export type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'offline' | 'forbidden' | 'unavailable';
export type ScreenId = 'setup' | 'invite' | 'login' | 'shell' | 'conversation' | 'composer' | 'thread' | 'search' | 'pins' | 'members' | 'direct-messages' | 'uploads' | 'media' | 'gifs' | 'voice' | 'activities' | 'plex' | 'dj' | 'vm' | 'gimme' | 'notifications' | 'settings' | 'devices' | 'invites-admin' | 'report' | 'reports-admin' | 'servers-admin' | 'channels-admin' | 'roles-admin';
export interface Field { name: string; label: string; type?: 'text' | 'password' | 'number' | 'checkbox' | 'file'; value?: string; required?: boolean }
export interface Action { id: string; label: string; disabled?: boolean }
export interface Item { id: string; text: string; richText?: MarkdownNode[]; actions?: Action[] }
export interface Intent { screen: ScreenId; action: string; itemId?: string; values: Record<string, string | boolean> }
export interface ScreenProps {
  id: ScreenId; title: string; phase: Phase; error?: string; busy?: boolean;
  fields?: Field[]; items?: Item[]; actions?: Action[]; submitLabel?: string;
  onIntent: (intent: Intent) => Promise<void>;
}
export interface Capability { available: boolean; reason?: string }
export interface AudioPreferences { bitrate: number; stereo: boolean; fullband: boolean; noiseSuppression: boolean }
export const defaultAudio: AudioPreferences = { bitrate: 510000, stereo: true, fullband: true, noiseSuppression: false };
