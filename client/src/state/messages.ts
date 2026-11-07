export interface Message {
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  created_at: number;
  revision?: number;
  reply_to?: string | null;
  pinned?: boolean;
  reactions?: { emoji: string; user_id: string }[];
  attachments?: { id: string; filename: string; length: string; video_path?: string | null; thumbnail_path?: string | null }[];
}
/** A tombstone always wins, including against a late response from before unsend. */
export class MessageStore {
  private messages = new Map<string, Message>();
  private tombstones = new Set<string>();
  upsert(message: Message) {
    if (this.tombstones.has(message.id)) return;
    const previous = this.messages.get(message.id);
    if (previous && (previous.revision ?? 0) > (message.revision ?? 0)) return;
    this.messages.set(message.id, message);
  }
  retract(id: string) {
    this.tombstones.add(id);
    this.messages.delete(id);
  }
  list(channelId: string) {
    return [...this.messages.values()]
      .filter((m) => m.channel_id === channelId)
      .sort((a, b) => a.created_at - b.created_at);
  }
  clear() {
    this.messages.clear();
    this.tombstones.clear();
  }
  isDeleted(id: string) {
    return this.tombstones.has(id);
  }
}
