import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
test("scanned upload transcodes, streams to a member before full buffering, and unsend removes playback", async ({ browser, request }) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "chriscord-video-fixture-"));
  const password = "synthetic video password 123";
  const headers = (s: any) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });
  const owner = await (await request.post("/api/setup", { data: { setup_token: "test-setup-token-at-least-32-characters", username: "video_owner", password, device_name: "fixture" } })).json();
  async function invite(username: string) {
    const link = await (await request.post("/api/invites", { headers: headers(owner), data: { email: "fixture@example.test", expires_in_seconds: 300 } })).json();
    return (await request.post("/api/invites/accept", { data: { token: link.token, username, password, device_name: "fixture" } })).json();
  }
  const friend = await invite("video_friend"), stranger = await invite("video_stranger");
  const channel = await (await request.post("/api/channels", { headers: headers(owner), data: { name: "Private video", kind: "dm", member_ids: [friend.user.id] } })).json();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  async function login(page: Page, username: string) {
    await page.goto("/"); await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password (at least 12 characters)").fill(password);
    await page.getByTestId("screen-login").locator("button[type=submit]").click();
    await page.getByRole("button", { name: "Open Private video", exact: true }).click();
  }
  try {
    const source = join(directory, "fixture.webm");
    await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", "-b:v", "150k", "-c:a", "libopus", source], { timeout: 30000 });
    const [a, b] = pages;
    await login(a, "video_owner"); await login(b, "video_friend");
    await a.getByRole("button", { name: "Upload file", exact: true }).click();
    await a.getByLabel("File", { exact: true }).setInputFiles(source);
    await a.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(a.getByTestId("screen-uploads")).toContainText("bytes (ready)", { timeout: 30000 });
    await a.getByRole("button", { name: "Prepare video and thumbnail", exact: true }).click();
    await expect(a.getByTestId("screen-uploads")).toContainText("Video: ready", { timeout: 30000 });
    await a.getByRole("button", { name: "Attach to message", exact: true }).click();
    await a.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill("Private streamed video");
    await a.getByRole("button", { name: "Send", exact: true }).click();
    await b.getByRole("button", { name: "Play fixture.webm", exact: true }).click();
    const video = b.getByTestId("uploaded-media");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
    const state = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, bufferedEnd: v.buffered.end(v.buffered.length - 1), frames: v.getVideoPlaybackQuality().totalVideoFrames, error: v.error?.code ?? 0 }));
    expect(state.frames).toBeGreaterThan(0); expect(state.error).toBe(0); expect(state.bufferedEnd).toBeLessThan(45);
    await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 55; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2 && v.currentTime >= 54.9 && Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a, b]) => a <= 55 && b > 55))).toBe(true);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(55.3);
    const late = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, bufferedStart: v.buffered.start(0) }));
    expect(late.frames).toBeGreaterThan(state.frames); expect(late.bufferedStart).toBeGreaterThan(30);
    await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 2; });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2 && v.buffered.length > 0 && v.buffered.start(0) <= 2 && v.buffered.end(0) > 2)).toBe(true);
    const message = (await (await request.get(`/api/channels/${channel.id}/messages`, { headers: headers(owner) })).json()).messages[0];
    const attachment = message.attachments[0];
    for (const path of [attachment.video_path, `${attachment.video_path}/seek?time=55`, attachment.thumbnail_path]) {
      expect((await request.get(path)).status()).toBe(401);
      expect((await request.get(path, { headers: headers(stranger) })).status()).toBe(403);
    }
    const thumbnail = await request.get(attachment.thumbnail_path, { headers: headers(friend) });
    expect(thumbnail.status()).toBe(200); expect(thumbnail.headers()["content-type"]).toBe("image/jpeg");
    await a.getByRole("button", { name: "Unsend", exact: true }).click();
    await expect(video).toHaveCount(0);
    expect((await request.get(attachment.video_path, { headers: headers(friend) })).status()).toBe(409);
    expect((await request.get(`${attachment.video_path}/seek?time=55`, { headers: headers(friend) })).status()).toBe(409);
    expect((await request.get(`/api/media/${attachment.id}`, { headers: headers(friend) })).status()).toBe(404);
    await writeFile(`../evidence/media-upload-seek-${randomUUID()}.json`, JSON.stringify({ passed: true, sourceSeconds: 60, decodedBeforeFullBuffer: state, lateSeek: late, checks: ["real ClamAV upload", "real FFmpeg encrypted video+thumbnail", "authenticated MSE decode before full buffering", "forward seek beyond retained buffer and backward seek to evicted fragment", "cross-user and anonymous denial", "thumbnail content type", "unsend stops client and deletes derivative"], limitations: "Actual browser decoder checks cover forward/backward seeks with bounded buffering; native WebView and ManagedMediaSource require separate proper-device execution." }, null, 2) + "\n", { flag: "wx" });
  } finally { for (const context of contexts) await context.close(); await rm(directory, { recursive: true, force: true }); }
});
