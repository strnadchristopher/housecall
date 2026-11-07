import { describe, it, expect, vi } from "vitest";
import { MessageStore } from "../src/state/messages";
import { NotificationReconciler } from "../src/transport/notifications";
import { Api } from "../src/transport/api";
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
import {opusFullband} from '../src/transport/voice';
it('requests fullband stereo maximum Opus bitrate without changing other codecs',()=>{const sdp='a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=0;maxaveragebitrate=64000\r\na=rtpmap:96 VP8/90000\r\n';const next=opusFullband(sdp);expect(next).toContain('maxaveragebitrate=510000');expect(next).toContain('stereo=1');expect(next).not.toContain('stereo=0');expect(next).toContain('VP8/90000');expect(next).toContain('minptime=10');});
