import type { ServerEvent } from "../data/types";
export class TypingStore {
  private entries = new Map<
    string,
    { userId: string; channelId: string; expiresAt: number }
  >();
  apply(event: ServerEvent) {
    if (event.kind !== "typing" || !event.channel_id) return;
    const userId = String(event.payload.user_id);
    const key = `${event.channel_id}:${userId}`;
    if (event.payload.active === true)
      this.entries.set(key, {
        userId,
        channelId: event.channel_id,
        expiresAt: Number(event.payload.expires_at),
      });
    else this.entries.delete(key);
  }
  list(channelId: string, now = Date.now()) {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
    return [...this.entries.values()]
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => entry.userId);
  }
  clear() {
    this.entries.clear();
  }
}
