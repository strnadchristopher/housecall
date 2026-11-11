/**
 * iOS system call screen (CallKit) and VoIP push (PushKit), through the callkit plugin in
 * src-tauri/plugins/tauri-plugin-callkit. Every function is a no-op that answers "unsupported"
 * outside the Tauri iOS app, so callers need no platform checks beyond `isCallKit()`.
 */
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export interface CallKitPending {
  channelId: string;
  name: string;
  /** The user answered on the system screen before this webview was ready to hear about it. */
  answered: boolean;
}
export type CallKitEvent = "voipToken" | "answer" | "end" | "mute" | "audio" | "reset";
type Payload = Record<string, unknown>;

function internals(): { invoke: Invoke } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
}

/** True only in the Tauri iOS app (iPhone, and iPad even when it reports a desktop user agent). */
export function isCallKit(): boolean {
  if (!internals() || typeof navigator === "undefined") return false;
  return /iphone|ipad/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

async function run<T extends Payload>(action: string, payload: Payload = {}): Promise<T & { supported?: boolean }> {
  const tauri = internals();
  if (!tauri || !isCallKit()) return { supported: false } as T & { supported: boolean };
  try {
    return await tauri.invoke<T & { supported?: boolean }>("callkit", { action, payload });
  } catch (error) {
    // Tauri serializes Rust Result<_, String> failures as strings, not Error objects.
    throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "CallKit operation failed");
  }
}

export const callKit = {
  /** Starts PushKit (the plugin also starts it at launch) and returns the current VoIP token, if iOS has issued one. */
  register: () => run<{ token?: string }>("register"),
  /** Shows the system incoming-call screen. Resolves false when it could not be asked (not iOS, plugin missing). */
  reportIncoming: async (channelId: string, displayName: string): Promise<boolean> => {
    try { return (await run("report_incoming", { channelId, displayName })).supported === true; } catch { return false; }
  },
  startOutgoing: (channelId: string, displayName: string) => run("start_outgoing", { channelId, displayName }),
  connected: (channelId: string) => run("connected", { channelId }),
  /** Ends the system call. `remote` tells CallKit the other side ended or declined instead of asking it to end. */
  end: (channelId: string, options: { remote?: boolean; declined?: boolean } = {}) => run("end", { channelId, ...options }),
  /** Shows the Housecall mute state on the system call screen. The plugin does not echo it back as a `mute` event. */
  mute: (channelId: string, muted: boolean) => run("mute", { channelId, muted }),
  /** Marks the system call as a video call while the camera is on. */
  video: (channelId: string, on: boolean) => run("video", { channelId, video: on }),
  /** The ringing or answered call a cold-started webview should know about. */
  pending: async (): Promise<CallKitPending | undefined> => (await run<{ pending?: CallKitPending }>("pending")).pending,
};

const listeners = new Map<CallKitEvent, Set<(data: Payload) => void>>();
const subscribed = new Set<CallKitEvent>();

/** Subscribes to a native event. One native subscription per event is shared by every caller. Returns an unsubscribe. */
export function onCallKit(event: CallKitEvent, callback: (data: Payload) => void): () => void {
  const set = listeners.get(event) ?? new Set();
  set.add(callback);
  listeners.set(event, set);
  const tauri = internals();
  if (tauri && isCallKit() && !subscribed.has(event)) {
    subscribed.add(event);
    void import("@tauri-apps/api/core").then(({ Channel }) => {
      const handler = new Channel<Payload>(data => { for (const listener of [...(listeners.get(event) ?? [])]) listener(data); });
      return tauri.invoke("callkit_listen", { event, handler });
    }).catch(() => subscribed.delete(event));
  }
  return () => { set.delete(callback); };
}
