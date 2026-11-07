interface NotificationHandle {
  close(): void;
}
export interface NotificationRecord {
  id: string;
  message_id: string;
  body?: string;
  retracted?: boolean;
  retracted_at?: number | null;
}
/** Closed notifications and tombstones are keyed by message, across notification IDs. */
export class NotificationReconciler {
  private active = new Map<string, NotificationHandle[]>();
  private deleted = new Set<string>();
  private seen = new Set<string>();
  constructor(
    private create: (
      record: NotificationRecord,
    ) => NotificationHandle | undefined = (record) => {
      if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      return new Notification("Chriscord", {
        body: record.body ?? "New message",
        tag: record.message_id,
      });
    },
  ) {}
  reconcile(records: NotificationRecord[]) {
    // Apply all tombstones before any deliveries, irrespective of response ordering.
    for (const n of records)
      if (n.retracted || n.retracted_at != null) this.retract(n.message_id);
    for (const n of records) {
      if (this.deleted.has(n.message_id) || this.seen.has(n.id)) continue;
      this.seen.add(n.id);
      const handle = this.create(n);
      if (handle)
        this.active.set(n.message_id, [
          ...(this.active.get(n.message_id) ?? []),
          handle,
        ]);
    }
  }
  retract(messageId: string) {
    this.deleted.add(messageId);
    for (const handle of this.active.get(messageId) ?? []) handle.close();
    this.active.delete(messageId);
  }
  clear() {
    for (const handles of this.active.values())
      for (const handle of handles) handle.close();
    this.active.clear();
    this.deleted.clear();
    this.seen.clear();
  }
}
