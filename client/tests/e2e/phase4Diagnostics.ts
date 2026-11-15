import type { APIRequestContext, BrowserContext, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.flatMap(key => {
  const item = object(value)[key];
  return item === null || ["string", "number", "boolean"].includes(typeof item) ? [[key, item]] : [];
}));
const diagnosticKeys = "ice_state received_datagrams transmitted_datagrams forwarding_not_ready forwarding_codec_mismatch incoming_tracks outgoing_open outgoing_waiting outgoing_negotiating pending_offer_ms output_maintenance_us output_protocol_us output_calls signaling_queued_bytes signaling_backpressure signaling_sent last_signal_in_bytes last_signal_out_bytes last_signal_in_m_lines last_signal_out_m_lines".split(" ");
const workerKeys = "max_iteration_us max_output_batch max_receive_batch ingress_dropped max_ingress_age_us max_propagation_batch iterations control_us output_us propagation_us receive_us timers_us".split(" ");

/** Explicit response allowlists: no session/device keys, SDP, candidates, headers or arbitrary payloads. */
export function voiceSummary(kind: "rooms" | "stats" | "join", value: unknown, room: string) {
  const body = object(value);
  if (kind === "join") return pick(body, ["peer_id"]);
  if (kind === "rooms") return {
    room,
    users: list(object(body.rooms)[room]).filter(id => typeof id === "string"),
    states: list(object(body.states)[room]).map(state => pick(state, ["user_id", "muted", "deafened", "camera", "sharing", "joined_at"])),
  };
  return { peers: list(body.peers).map(value => {
    const peer = object(value);
    return {
      ...pick(peer, ["peer_id", "user_id", "connected", "publisher", "current_session", "received_frames", "forwarded_frames", "forwarded_bytes"]),
      diagnostics: pick(peer.diagnostics, diagnosticKeys),
      recent_disconnects: list(peer.recent_disconnects).map(closed => ({ ...pick(closed, ["peer_id", "reason", "age_ms"]), diagnostics: pick(object(closed).diagnostics, diagnosticKeys) })),
      worker: pick(peer.worker, workerKeys),
    };
  }) };
}

/** Self-contained for addInitScript: observe native calls without changing arguments/results. */
export function installPhase4PcProbe() {
  const Original = window.RTCPeerConnection;
  const peers: RTCPeerConnection[] = [];
  const events: Record<string, string | number>[] = [];
  const channels: { peer: number; channel: number; sent: number; received: number; sentBytes: number; receivedBytes: number; throws: number }[] = [];
  Object.assign(window, { __phase4Peers: peers, __phase4PcEvents: events, __phase4Channels: channels });
  const bytes = (value: unknown): number => typeof value === "string" ? new TextEncoder().encode(value).byteLength
    : value instanceof Blob ? value.size : value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value.byteLength : 0;
  // Fixed names only; custom error names and all messages could contain payloads.
  const errorName = (error: unknown) => {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "Error";
    return ["Error", "TypeError", "RangeError", "InvalidStateError", "OperationError", "NetworkError", "NotSupportedError", "InvalidAccessError", "SyntaxError", "AbortError", "RTCError"].includes(name) ? name : "Error";
  };
  const description = (value: unknown) => {
    const item = value as RTCSessionDescriptionInit | undefined;
    return { type: ["offer", "answer", "pranswer", "rollback"].includes(item?.type ?? "") ? item!.type : "implicit", bytes: bytes(item?.sdp) };
  };
  let operation = 0;
  window.RTCPeerConnection = new Proxy(Original, { construct(Target, args, NewTarget) {
    const pc: RTCPeerConnection = Reflect.construct(Target, args, NewTarget), index = peers.length;
    peers.push(pc);
    const record = (event: string, details: Record<string, string | number> = {}) => {
      events.push({ at: performance.timeOrigin + performance.now(), peer: index, event,
        connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState, ...details });
      if (events.length > 512) events.shift();
    };
    for (const event of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange", "signalingstatechange"]) pc.addEventListener(event, () => record(event));
    for (const name of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription"] as const) {
      Object.defineProperty(pc, name, { configurable: true, writable: true, value: new Proxy(pc[name], { apply(target, receiver, args) {
        const id = ++operation, input = name.startsWith("set") ? description(args[0]) : { type: name === "createOffer" ? "offer" : "answer", bytes: 0 };
        record("sdp-entry", { operation: name, id, ...input });
        try {
          const result = Reflect.apply(target, receiver, args);
          // Observe with a side branch, returning the exact native promise to the caller.
          if (result && typeof result.then === "function") void result.then((value: unknown) => record("sdp-complete", { operation: name, id,
            ...description(name.startsWith("create") ? value : name === "setLocalDescription" ? pc.localDescription : pc.remoteDescription) }),
          (error: unknown) => record("sdp-reject", { operation: name, id, ...input, error: errorName(error) }));
          return result;
        } catch (error) { record("sdp-throw", { operation: name, id, ...input, error: errorName(error) }); throw error; }
      } }) });
    }
    const seen = new WeakSet<RTCDataChannel>();
    const cleanups: (() => void)[] = [];
    const observe = (dc: RTCDataChannel) => {
      if (dc.label !== "housecall-signaling" || seen.has(dc) || channels.length >= 16) return;
      seen.add(dc);
      const counter = { peer: index, channel: channels.length, sent: 0, received: 0, sentBytes: 0, receivedBytes: 0, throws: 0 };
      channels.push(counter);
      const state = () => ({ channel: counter.channel, bufferedAmount: dc.bufferedAmount, readyState: dc.readyState });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { clearTimeout(timer); timer = undefined; };
      cleanups.push(stop);
      // At most three sparse samples per buffered burst; no stats polling or threshold mutation.
      const drain = (sample = 0) => {
        if (timer !== undefined || !dc.bufferedAmount || dc.readyState === "closed" || pc.signalingState === "closed") return;
        timer = setTimeout(() => {
          timer = undefined;
          record("buffer-drain", { ...state(), sample });
          if (sample < 2) drain(sample + 1);
        }, [250, 1000, 4000][sample]);
      };
      for (const event of ["open", "error", "close"]) dc.addEventListener(event, () => {
        // RTC error events contain transport details, so persist only the fixed event name.
        record(`channel-${event}`, state());
        if (event === "close") stop();
      });
      dc.addEventListener("message", event => { counter.received++; counter.receivedBytes += bytes(event.data); });
      dc.send = new Proxy(dc.send, { apply(target, receiver, args) {
        const size = bytes(args[0]);
        record("send-entry", { ...state(), bytes: size });
        try {
          const result = Reflect.apply(target, receiver, args);
          counter.sent++; counter.sentBytes += size;
          record("send-return", { ...state(), bytes: size }); drain();
          return result;
        } catch (error) {
          counter.throws++; record("send-throw", { ...state(), bytes: size, error: errorName(error) }); throw error;
        }
      } });
      record("channel-observed", state());
    };
    pc.createDataChannel = new Proxy(pc.createDataChannel, { apply(target, receiver, args) {
      const dc = Reflect.apply(target, receiver, args); observe(dc); return dc;
    } });
    pc.addEventListener("datachannel", event => observe(event.channel));
    const stop = () => cleanups.forEach(cleanup => cleanup());
    pc.close = new Proxy(pc.close, { apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args); stop(); record("pc-close"); return result;
    } });
    window.addEventListener("pagehide", stop, { once: true });
    record("pc-created");
    return pc;
  } });
}

type Observation = { at: number; kind: string; status: number; summary?: unknown; unavailable?: boolean };
const observations = new WeakMap<Page, { name: string; responses: Observation[] }>();
export function watchVoice(page: Page, name: string) {
  const record = { name, responses: [] as Observation[] }; observations.set(page, record);
  page.on("response", async response => {
    const path = new URL(response.url()).pathname;
    const match = path.match(/^\/api\/channels\/([^/]+)\/voice\/(stats|join)$/);
    if (path !== "/api/voice/rooms" && !match) return;
    const entry: Observation = { at: Date.now(), kind: match?.[2] ?? "rooms", status: response.status() };
    record.responses.push(entry); if (record.responses.length > 80) record.responses.shift();
    try {
      // Rooms is scoped at capture time; retain only the response's public roster fields.
      const body = await response.json();
      entry.summary = entry.kind === "rooms"
        ? Object.fromEntries(Object.keys(object(object(body).rooms)).map(room => [room, voiceSummary("rooms", body, room)]))
        : voiceSummary(entry.kind as "stats" | "join", body, match![1]);
    } catch { entry.unavailable = true; }
  });
}

/** Before teardown on either outcome; sample every page, including departed peers. */
export async function captureVoiceTrace(contexts: BrowserContext[], request: APIRequestContext, headers: Record<string, string>, room: string, info: TestInfo, outcome: "success" | "failure") {
  const pages = await Promise.all(contexts.flatMap(context => context.pages()).map(async page => {
    const record = observations.get(page);
    try {
      const state = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('[data-testid="call-stage"]');
        return {
          phase: root?.dataset.phase ?? null,
          // Error categories only: never serialize arbitrary exception messages or user content.
          errors: [...(root?.querySelectorAll('[role="alert"]') ?? [])].map(node => {
            const text = node.textContent ?? "";
            return { category: /capacity/i.test(text) ? "capacity" : /unauthorized/i.test(text) ? "unauthorized" : /couldn.t join/i.test(text) ? "join-failed" : /transport/i.test(text) ? "transport" : "other", characters: text.length };
          }),
          tiles: [...document.querySelectorAll<HTMLElement>('[data-testid="call-tile"]')].map(node => ({ peerId: node.dataset.peerId, key: node.dataset.tileKey, stream: node.classList.contains("hc-tile--stream"), visible: !!node.getClientRects().length })),
          roster: [...document.querySelectorAll('.hc-vrow__open')].map(node => node.getAttribute("aria-label")),
          peers: ((window as unknown as { __phase4Peers?: RTCPeerConnection[] }).__phase4Peers ?? []).map((pc, peer) => ({
            peer, connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState,
            senders: pc.getSenders().map(sender => ({ kind: sender.track?.kind, state: sender.track?.readyState, enabled: sender.track?.enabled })),
            receivers: pc.getReceivers().map(receiver => ({ kind: receiver.track.kind, state: receiver.track.readyState, muted: receiver.track.muted })),
          })),
          events: (window as unknown as { __phase4PcEvents?: unknown[] }).__phase4PcEvents ?? [],
          channels: (window as unknown as { __phase4Channels?: unknown[] }).__phase4Channels ?? [],
        };
      });
      return { name: record?.name, capturedAt: Date.now(), state, responses: record?.responses };
    } catch { return { name: record?.name, unavailable: true, responses: record?.responses }; }
  }));
  // The setup session may observe rooms but is not the browser's joined session.
  // Per-page automatic stats responses above provide the authenticated SFU view.
  const server = await Promise.all((["rooms"] as const).map(async kind => {
    try {
      const response = await request.get("/api/voice/rooms", { headers, timeout: 5000 });
      return { kind, at: Date.now(), status: response.status(), summary: voiceSummary(kind, await response.json(), room) };
    } catch { return { kind, unavailable: true }; }
  }));
  const artifact = outcome === "failure" ? "sfu-grid-failure" : "sfu-signaling-success";
  const path = info.outputPath(`${artifact}.json`);
  await writeFile(path, JSON.stringify({ room, outcome, capturedAt: Date.now(), pages, server }, null, 2));
  await info.attach(artifact, { path, contentType: "application/json" });
}
