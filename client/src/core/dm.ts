import type { Payload } from '../crypto/dm';
import type { PeerSecurity } from './security';
export interface DmContext { id: string; kind: 'dm' | 'group_dm' | 'channel' | 'voice'; memberIds: readonly string[] }
export interface SecureMessageRow {
  id: string; channel_id: string; author_id: string; body: string; enc?: number; envelope?: string | null;
  reply_to?: string | null; revision?: number; edited_at?: number | null; attachments?: { id: string }[];
}
export type ReplyStatus = 'none' | 'authenticated' | 'unchecked' | 'edited';
export type OpenedDmMessage =
  | { status: 'plaintext'; body: string; marker: 'not-encrypted' | null; encrypted: false }
  | { status: 'opened'; payload: Payload; nonce: string; encrypted: true; reply: ReplyStatus }
  | { status: 'locked' | 'old-own-key' | 'unchecked-peer-key' | 'held' | 'failed' | 'unsupported' | 'duplicate'; encrypted: false };
export function plaintextMessage(body: string, peer?: PeerSecurity): OpenedDmMessage {
  return { status: 'plaintext', body, marker: peer?.pin || (peer && peer.state !== 'NONE') ? 'not-encrypted' : null, encrypted: false };
}
/** Only authenticated, opened current envelopes from the same conversation can supply a quote. */
export function replyStatus(payload: Payload, row: SecureMessageRow, target?: SecureMessageRow, openedTarget?: OpenedDmMessage): ReplyStatus {
  if (!payload.re && !row.reply_to) return 'none';
  if (!payload.re || !row.reply_to || !target || target.id !== row.reply_to || target.channel_id !== row.channel_id || target.enc !== 1 || openedTarget?.status !== 'opened') return 'unchecked';
  if (payload.re === openedTarget.nonce) return 'authenticated';
  return target.edited_at ? 'edited' : 'unchecked';
}
