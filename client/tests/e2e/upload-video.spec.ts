import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { act, signIn } from "./helpers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
test("scanned upload transcodes, streams to a member before full buffering, and unsend removes playback", async ({ browser, request }) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "housecall-video-fixture-"));
  const password = "synthetic video password 123";
  const headers = (s: any) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });
  const owner = await (await request.post("/api/setup", { data: { setup_token: "test-setup-token-at-least-32-characters", username: "video_owner", password, device_name: "fixture" } })).json();
  async function invite(username: string) {
    const link = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
    return (await request.post("/api/invites/accept", { data: { token: link.token, username, password, device_name: "fixture" } })).json();
  }
  const friend = await invite("video_friend"), stranger = await invite("video_stranger");
  const channel = await (await request.post("/api/channels", { headers: headers(owner), data: { name: "Private video", kind: "dm", member_ids: [friend.user.id] } })).json();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  async function login(page: Page, username: string) {
    await page.goto("/");
    await signIn(page, username, password);
    await page.getByRole("button", { name: "Direct messages", exact: true }).click();
    await page.getByRole("button", { name: "Open Private video", exact: true }).click();
  }
  try {
    const source = join(directory, "fixture.webm");
    await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", "-b:v", "150k", "-c:a", "libopus", source], { timeout: 30000 });
    const [a, b] = pages;
    await login(a, "video_owner"); await login(b, "video_friend");
    // A scanned upload is attached to the draft by the composer; video preparation is offered once it is ready.
    await a.getByTestId("screen-composer").locator('input[type="file"]').setInputFiles(source);
    const attached = a.getByTestId("attached");
    await expect(attached).toContainText("fixture.webm", { timeout: 30000 });
    await a.getByRole("button", { name: "Prepare video", exact: true }).click();
    await expect(attached).toContainText("Video ready", { timeout: 30000 });
    await a.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill("Private streamed video");
    await a.getByRole("button", { name: "Send", exact: true }).click();
    // The video is in the message already: no Play click and no download.
    const video = b.getByTestId("uploaded-media");
    // The E2E server is a debug build, so decrypting and serving fragments is unoptimized: first metadata takes
    // 2-5 s and a backward seek re-buffers at a few seconds of media per second. Default 5 s polls failed about
    // 1 run in 8; every streaming poll gets 15 s.
    await video.waitFor({ state: "attached", timeout: 15000 });
    // preload="metadata" may stop at HAVE_METADATA until playback is requested, so wait for metadata, then play.
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(1);
    const state = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, bufferedEnd: v.buffered.end(v.buffered.length - 1), frames: v.getVideoPlaybackQuality().totalVideoFrames, error: v.error?.code ?? 0 }));
    expect(state.frames).toBeGreaterThan(0); expect(state.error).toBe(0); expect(state.bufferedEnd).toBeLessThan(45);
    await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 55; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2 && v.currentTime >= 54.9 && Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a, b]) => a <= 55 && b > 55)), { timeout: 15000 }).toBe(true);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(55.3);
    const late = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, bufferedStart: v.buffered.start(0) }));
    expect(late.frames).toBeGreaterThan(state.frames); expect(late.bufferedStart).toBeGreaterThan(30);
    await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 2; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2 && v.buffered.length > 0 && v.buffered.start(0) <= 2 && v.buffered.end(0) > 2), { timeout: 15000 }).toBe(true);
    const message = (await (await request.get(`/api/channels/${channel.id}/messages`, { headers: headers(owner) })).json()).messages[0];
    const attachment = message.attachments[0];
    for (const path of [attachment.video_path, `${attachment.video_path}/seek?time=55`, attachment.thumbnail_path]) {
      expect((await request.get(path)).status()).toBe(401);
      expect((await request.get(path, { headers: headers(stranger) })).status()).toBe(403);
    }
    const thumbnail = await request.get(attachment.thumbnail_path, { headers: headers(friend) });
    expect(thumbnail.status()).toBe(200); expect(thumbnail.headers()["content-type"]).toBe("image/jpeg");
    await act(a, "Private streamed video", "Unsend");
    await a.getByRole("button", { name: "Unsend for everyone", exact: true }).click();
    await expect(video).toHaveCount(0);
    expect((await request.get(attachment.video_path, { headers: headers(friend) })).status()).toBe(409);
    expect((await request.get(`${attachment.video_path}/seek?time=55`, { headers: headers(friend) })).status()).toBe(409);
    expect((await request.get(`/api/media/${attachment.id}`, { headers: headers(friend) })).status()).toBe(404);
    await mkdir("../evidence", { recursive: true });
    await writeFile(`../evidence/media-upload-seek-${randomUUID()}.json`, JSON.stringify({ passed: true, sourceSeconds: 60, decodedBeforeFullBuffer: state, lateSeek: late, checks: ["real ClamAV upload", "real FFmpeg encrypted video+thumbnail", "authenticated MSE decode before full buffering", "forward seek beyond retained buffer and backward seek to evicted fragment", "cross-user and anonymous denial", "thumbnail content type", "unsend stops client and deletes derivative"], limitations: "Actual browser decoder checks cover forward/backward seeks with bounded buffering; native WebView and ManagedMediaSource require separate proper-device execution." }, null, 2) + "\n", { flag: "wx" });
  } finally { for (const context of contexts) await context.close(); await rm(directory, { recursive: true, force: true }); }
});

test("images and gifs show inline with a lightbox, other files stay cards, and a video flips from processing to playable without a reload", async ({ browser, request }) => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "housecall-media-fixture-"));
  const password = "synthetic video password 123";
  const headers = (s: any) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });
  // The server is shared with the first test in this file, so setup may already have happened.
  let ownerResponse = await request.post("/api/setup", { data: { setup_token: "test-setup-token-at-least-32-characters", username: "video_owner", password, device_name: "fixture" } });
  if (ownerResponse.status() === 409) ownerResponse = await request.post("/api/login", { data: { username: "video_owner", password, device_name: "fixture" } });
  expect(ownerResponse.ok()).toBeTruthy();
  const owner = await ownerResponse.json();
  const link = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
  const friend = await (await request.post("/api/invites/accept", { data: { token: link.token, username: "media_friend", password, device_name: "fixture" } })).json();
  const channel = await (await request.post("/api/channels", { headers: headers(owner), data: { name: "Inline media", kind: "dm", member_ids: [friend.user.id] } })).json();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  async function login(page: Page, username: string) {
    await page.goto("/");
    await signIn(page, username, password);
    await page.getByRole("button", { name: "Direct messages", exact: true }).click();
    await page.getByRole("button", { name: "Open Inline media", exact: true }).click();
  }
  async function send(file: string, text: string) {
    await a.getByTestId("screen-composer").locator('input[type="file"]').setInputFiles(file);
    await expect(a.getByTestId("attached")).toContainText(file.split("/").pop()!, { timeout: 30000 });
    await a.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill(text);
    await a.getByRole("button", { name: "Send", exact: true }).click();
    return b.locator("[data-message-id]", { hasText: text });
  }
  try {
    const png = join(directory, "square.png"), gif = join(directory, "loop.gif"), webm = join(directory, "short.webm"), notes = join(directory, "notes.txt");
    const ffmpeg = (...args: string[]) => execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 30000 });
    await ffmpeg("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1", "-frames:v", "1", png);
    await ffmpeg("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5", "-t", "1", gif);
    await ffmpeg("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "3", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "100k", webm);
    await writeFile(notes, "plain notes for the file card\n");
    await login(a, "video_owner"); await login(b, "media_friend");

    const imageRow = await send(png, "inline png");
    const image = imageRow.getByTestId("inline-image");
    await expect(image).toBeVisible({ timeout: 15000 });
    await expect.poll(() => image.evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(imageRow.getByRole("button", { name: /^Download/ })).toHaveCount(0);

    // Lightbox: opens on click, closes on Escape.
    await imageRow.getByRole("button", { name: "Open square.png" }).click();
    const box = b.getByRole("dialog", { name: "square.png" });
    await expect(box).toBeVisible();
    await expect(box.getByRole("button", { name: "Download square.png" })).toBeVisible();
    await b.keyboard.press("Escape");
    await expect(box).toHaveCount(0);

    const gifRow = await send(gif, "inline gif");
    await expect(gifRow.getByTestId("inline-image")).toBeVisible({ timeout: 15000 });

    const notesRow = await send(notes, "plain file");
    await expect(notesRow.getByRole("button", { name: "Download notes.txt" })).toBeVisible({ timeout: 15000 });
    await expect(notesRow.getByTestId("inline-image")).toHaveCount(0);

    // Sent without "Prepare video": processing state, then playable once a transcode finishes, no reload.
    const videoRow = await send(webm, "unprepared video");
    await expect(videoRow.getByTestId("video-processing")).toBeVisible({ timeout: 15000 });
    const sent = (await (await request.get(`/api/channels/${channel.id}/messages`, { headers: headers(owner) })).json()).messages.find((m: any) => m.body === "unprepared video");
    const derived = await request.post(`/api/uploads/${sent.attachments[0].id}/derive`, { headers: headers(owner) });
    expect(derived.status()).toBe(202);
    const video = videoRow.getByTestId("uploaded-media");
    await expect(video).toBeVisible({ timeout: 45000 });
    await expect(videoRow.getByTestId("video-processing")).toHaveCount(0);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5000 }).toBeGreaterThan(0);
  } finally { for (const context of contexts) await context.close(); await rm(directory, { recursive: true, force: true }); }
});
