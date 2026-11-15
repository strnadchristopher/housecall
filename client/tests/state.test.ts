import { describe, it, expect, vi } from "vitest";
import { MessageStore } from "../src/state/messages";
import { NotificationReconciler } from "../src/transport/notifications";
import { Api } from "../src/transport/api";
import { clearNativePush } from "../src/transport/nativePush";
import { messageDetails } from "../src/data/messageView";
it("structured message metadata uses exact mentions and hides unavailable reply content", () => {
  const message = { id: "m", channel_id: "c", author_id: "author", created_at: 1,
    body: "Fake: @current (pinned)", mention_ids: ["current-other"], reply_to: "hidden",
    reactions: [{ emoji: "👍", user_id: "current" }, { emoji: "👍", user_id: "friend" }] };
  const result = messageDetails(message, "current", id => id, [
    { ...message, id: "hidden", channel_id: "private", body: "must not leak" },
  ]);
  expect(result.mentionsMe).toBe(false);
  expect(result.pinned).toBe(false);
  expect(result.replyTo).toBeNull();
  expect(result.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
});
it("attachment display kind comes from the server and falls back to video for legacy rows", () => {
  const base = { id: "m", channel_id: "c", author_id: "a", created_at: 1, body: "" };
  const result = messageDetails({ ...base, attachments: [
    { id: "1", filename: "a.png", length: "10", kind: "image" },
    { id: "2", filename: "b.mp4", length: "10", video_path: "/api/media-jobs/j/video" },
    { id: "3", filename: "c.txt", length: "10" },
  ] }, "me", id => id, []);
  expect(result.attachments.map(a => a.kind)).toEqual(["image", "video", "file"]);
});
it("preserves real Tauri string rejection messages across native cleanup", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (_command: string, args: {action: string}) => {
    if (args.action === "status") return { supported: true };
    throw "Background notification cleanup failed; try again before switching accounts";
  } } });
  try {
    await expect(clearNativePush()).rejects.toThrow("Background notification cleanup failed; try again before switching accounts");
  } finally { vi.unstubAllGlobals(); }
});
const message = {
  id: "m1",
  channel_id: "c1",
  author_id: "u1",
  body: "hello",
  created_at: 1,
  revision: 1,
};
describe("unsend reconciliation", () => {
  it("deletion wins over delayed fetches and edits", () => {
    const state = new MessageStore();
    state.upsert(message);
    state.retract("m1");
    state.upsert({ ...message, revision: 100 });
    expect(state.list("c1")).toEqual([]);
  });
  it("ignores old edits and isolates conversations", () => {
    const state = new MessageStore();
    state.upsert({ ...message, revision: 2, body: "new" });
    state.upsert(message);
    expect(state.list("c1")[0].body).toBe("new");
    expect(state.list("c2")).toEqual([]);
  });
  it("closes delivered notification and prevents stale redelivery", () => {
    const close = vi.fn(),
      create = vi.fn(() => ({ close }));
    const ns = new NotificationReconciler(create);
    ns.reconcile([{ id: "n1", message_id: "m1" }]);
    ns.retract("m1");
    ns.reconcile([{ id: "n2", message_id: "m1" }]);
    expect(close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
  it("processes tombstones before unordered deliveries", () => {
    const create = vi.fn();
    const ns = new NotificationReconciler(create);
    ns.reconcile([
      { id: "n1", message_id: "m1" },
      { id: "n2", message_id: "m1", retracted: true },
    ]);
    expect(create).not.toHaveBeenCalled();
  });
});
it("rejects insecure remote origins and credential-bearing origins", () => {
  expect(() => new Api("http://example.com")).toThrow("HTTPS");
  expect(() => new Api("https://user:secret@example.com")).toThrow();
  expect(() => new Api("http://127.0.0.1:3000")).not.toThrow();
});

import {
  mentionedUsers,
  mentionCandidates,
  completeMention,
} from "../src/data/mentions";
const members = [
  { id: "u1", username: "bob", is_owner: false },
  { id: "u2", username: "bobby", is_owner: false },
];
it("mentions do not notify users with overlapping names or email substrings", () => {
  expect(mentionedUsers("@bobby hello bob@example.com", members)).toEqual([
    "u2",
  ]);
  expect(mentionedUsers("Hi @bob!", members)).toEqual(["u1"]);
  expect(mentionCandidates("hi @bo", members)).toHaveLength(2);
  expect(completeMention("hi @bo", "bob")).toBe("hi @bob ");
});
import { TypingStore } from "../src/state/typing";
it("typing state expires and cannot cross channels", () => {
  const state = new TypingStore();
  state.apply({
    id: 1,
    kind: "typing",
    channel_id: "c1",
    payload: { user_id: "u1", active: true, expires_at: 100 },
    created_at: 0,
  });
  expect(state.list("c2", 50)).toEqual([]);
  expect(state.list("c1", 50)).toEqual(["u1"]);
  expect(state.list("c1", 101)).toEqual([]);
});
import { ResumableUpload, type Upload } from "../src/transport/uploads";
it("resumes at the server byte offset after interruption without repeating completed chunks", async () => {
  const file = new File([new Uint8Array(4 * 1024 * 1024 + 5)], "large.dat");
  let current: Upload = {
    id: "up",
    channel_id: "c",
    filename: file.name,
    length: String(file.size),
    offset: "0",
    status: "uploading",
  };
  const offsets: string[] = [];
  let paused = false;
  const api = {
    get: async () => ({ ...current }),
    request: async (_path: string, options: RequestInit) => {
      if (options.method === "POST") {
        current = { ...current, status: "quarantined" };
        return current;
      }
      const offset = new Headers(options.headers).get("Upload-Offset")!;
      offsets.push(offset);
      current = {
        ...current,
        offset: String(Number(offset) + (options.body as Blob).size),
      };
      return { ...current };
    },
    post: async () => {
      current = { ...current, status: "quarantined" };
      return current;
    },
  } as unknown as Api;
  const uploader = new ResumableUpload(api, (upload) => {
    if (upload.offset === "4194304" && !paused) {
      paused = true;
      uploader.pause();
    }
  });
  await expect(uploader.resume("up", file)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(current.offset).toBe("4194304");
  await uploader.resume("up", file);
  expect(offsets).toEqual(["0", "4194304"]);
  expect(current.status).toBe("quarantined");
});
it("account teardown suppresses delayed upload creation and completion callbacks", async () => {
  const file = new File(["private"], "private.txt");
  const upload: Upload = { id: "old", channel_id: "old-channel", filename: file.name, length: String(file.size), offset: String(file.size), status: "uploading" };
  for (const operation of ["create", "resume"] as const) {
    let finish!: (value: Upload) => void;
    const delayed = new Promise<Upload>(resolve => { finish = resolve; });
    const get = vi.fn(async () => upload);
    const request = vi.fn(() => delayed);
    const changed = vi.fn();
    const uploader = new ResumableUpload({ get, request } as unknown as Api, changed);
    const work = operation === "create" ? uploader.create("old-channel", file) : uploader.resume(upload.id, file);
    await Promise.resolve();
    changed.mockClear();
    uploader.pause();
    finish({ ...upload, status: "ready" });
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(changed).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(operation === "create" ? 0 : 1);
  }
});
import { opusFullband } from "../src/transport/voice";
it("requests fullband stereo maximum Opus bitrate without changing other codecs", () => {
  const sdp =
    "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=0;maxaveragebitrate=64000\r\na=rtpmap:96 VP8/90000\r\n";
  const next = opusFullband(sdp);
  expect(next).toContain("maxaveragebitrate=510000");
  expect(next).toContain("stereo=1");
  expect(next).not.toContain("stereo=0");
  expect(next).toContain("VP8/90000");
  expect(next).toContain("minptime=10");
});
import { firstPreviewLink } from "../src/data/embeds";
it("link previews are explicit HTTPS candidates only", () => {
  expect(firstPreviewLink("hello https://example.com/path.")).toBe(
    "https://example.com/path",
  );
  expect(
    firstPreviewLink("javascript:alert(1) http://example.com"),
  ).toBeUndefined();
});
import { markdownTokens } from "../src/data/markdown";
it("markdown produces inert data, strips image fetching and unsafe links, preserves formatting", () => {
  const ast = markdownTokens(
    "**hello** <script>alert(1)</script>\n\n[x](javascript:alert(1)) ![alt](https://tracker.example/x)",
  );
  const serialized = JSON.stringify(ast);
  expect(serialized).toContain('"kind":"strong"');
  expect(serialized).not.toContain('"href":"javascript:');
  expect(serialized).not.toContain("tracker.example");
  expect(serialized).toContain('"kind":"text","text":"<script>"');
  expect(
    markdownTokens("[safe](https://example.com)")[0].children?.[0].href,
  ).toBe("https://example.com/");
});

import { Api as MediaApi } from "../src/transport/api";
it("media requests keep device credentials on the configured API origin and reject redirects", () => {
  const api = new MediaApi("https://housecall.example");
  api.authenticate({ token: "fixture-token", device_key: "fixture-device" });
  const request = api.mediaRequest(
    "/api/channels/general/plex/resources/opaque",
  );
  expect(request.headers.get("X-Device-Key")).toBe("fixture-device");
  expect(request.redirect).toBe("error");
  expect(request.credentials).toBe("omit");
  expect(() =>
    api.mediaRequest("https://tracker.example/api/fragment"),
  ).toThrow();
  expect(() => api.mediaRequest("/api/../tracker")).toThrow();
});

import {
  mentionedRoles,
  roleCandidates,
  completeRole,
} from "../src/data/mentions";
it("roles with spaces are autocompleted and matched as exact names", () => {
  const roles = [
    { id: "movie", name: "Movie Night" },
    { id: "short", name: "Movie" },
  ];
  expect(
    roleCandidates("hello @Movie N", roles).map((role) => role.id),
  ).toEqual(["movie"]);
  expect(completeRole("hello @Movie N", "Movie Night")).toBe(
    "hello @Movie Night ",
  );
  expect(mentionedRoles("hello @Movie Night!", roles)).toEqual(["movie"]);
  expect(mentionedRoles("@Movie Nights", roles)).not.toContain("movie");
});

import { initializationMime } from "../src/transport/video";
describe("bounded video initialization", () => {
  it("rejects zero, extended and oversized boxes; waits for incomplete headers", () => {
    expect(initializationMime(new Uint8Array([0, 0, 0]))).toBeUndefined();
    for (const size of [0, 1, 7, 1048577, 0xffffffff]) {
      const bytes = new Uint8Array(8); new DataView(bytes.buffer).setUint32(0, size);
      expect(() => initializationMime(bytes)).toThrow();
    }
    const incomplete = new Uint8Array(8); new DataView(incomplete.buffer).setUint32(0, 24);
    expect(initializationMime(incomplete)).toBeUndefined();
    expect(() => initializationMime(new Uint8Array(1048577))).toThrow();
  });
  it("terminates on deterministic malformed byte inputs and emits no arbitrary MIME text", () => {
    let seed = 17;
    for (let length = 0; length < 512; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
      try {
        const mime = initializationMime(bytes);
        if (mime) expect(mime).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}(, mp4a\.40\.2)?"$/);
      } catch (error) { expect(error).toBeInstanceOf(Error); }
    }
  });
});

import { sideTabs, isStaged } from "../src/ui/shell/nav";
import { isSpeaking, SPEAKING_LEVEL } from "../src/core/call";
describe("call stage navigation", () => {
  it("shows Chat in the right column only while the stage owns the center", () => {
    expect(sideTabs(true, true)).toEqual(["chat", "people", "chords"]);
    expect(sideTabs(true, false)).toEqual(["chat", "people"]);
    expect(sideTabs(false, true)).toEqual(["people", "chords"]);
    expect(sideTabs(false, false)).toEqual(["people"]);
  });
  it("stages the call only for its own conversation, in a live, connecting or failed call, outside Settings", () => {
    const live = { phase: "live", conversationId: "a" };
    expect(isStaged(live, "a", "chat")).toBe(true);
    expect(isStaged({ phase: "connecting", conversationId: "a" }, "a", "chat")).toBe(true);
    expect(isStaged(live, "b", "chat")).toBe(false);
    expect(isStaged(live, "a", "settings")).toBe(false);
    expect(isStaged({ phase: "failed", conversationId: "a" }, "a", "chat")).toBe(true);
    expect(isStaged({ phase: "idle" }, "a", "chat")).toBe(false);
    expect(isStaged(live, undefined, "chat")).toBe(false);
  });
  it("counts a participant as speaking only above the level threshold", () => {
    expect(isSpeaking(undefined)).toBe(false);
    expect(isSpeaking(0)).toBe(false);
    expect(isSpeaking(SPEAKING_LEVEL)).toBe(false);
    expect(isSpeaking(SPEAKING_LEVEL + 0.001)).toBe(true);
    expect(isSpeaking(0.5)).toBe(true);
  });
});
