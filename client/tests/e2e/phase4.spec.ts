import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { b64u, publicIdentityKey } from "../../src/crypto/identity";
import { sealBackup } from "../../src/crypto/backup";
import { signIn, fillSignIn, logInButton, openMenu, send, row } from "./helpers";
import { tapAwayFromMessageTray } from "./messageTray";
import { watchVoice, captureVoiceTrace, installPhase4PcProbe } from "./phase4Diagnostics";

// Actual server + SFU throughout. Capture is synthetic, not native device verification.
const password = "synthetic phase4 password 123";
const setupToken = "test-setup-token-at-least-32-characters";
const directory = resolve(process.env.HOUSECALL_PHASE4_ARTIFACTS ?? `../docs/ux/phase4-correction-${Date.now()}-${process.pid}`);
type Session = { token: string; device_key: string; expires_at: number; user: { id: string; username: string } };
const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}`, "X-Device-Key": session.device_key });
let owner: Session;
let lounge: string;
const sizes = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

test.beforeAll(async ({ request }) => {
  await mkdir(directory, { recursive: true });
  let result = await request.post("/api/setup", { data: { username: "p4_owner", password, setup_token: setupToken, device_name: "phase4 synthetic" } });
  if (result.status() === 409) result = await request.post("/api/login", { data: { username: "p4_owner", password, device_name: "phase4 restart" } });
  expect(result.ok()).toBe(true); owner = await result.json();
  const me = await (await request.get("/api/me", { headers: auth(owner) })).json();
  expect(me.capabilities.voice, "Actual server/SFU fixture is not configured").toBe(true);
  const invite = await (await request.post("/api/invites", { headers: auth(owner), data: { expires_in_seconds: 3600, max_uses: 8 } })).json();
  for (let index = 1; index <= 8; index++) {
    const existing = await request.post("/api/login", { data: { username: `p4_${index}`, password, device_name: "phase4 restart" } });
    if (existing.ok()) continue;
    const accepted = await request.post("/api/invites/accept", { data: { token: invite.token, username: `p4_${index}`, password, device_name: "phase4 synthetic" } });
    expect(accepted.ok()).toBe(true);
  }
  const channels = await (await request.get("/api/channels", { headers: auth(owner) })).json();
  lounge = channels.channels.find((channel: { name: string }) => channel.name === "Lounge").id;
});

async function open(browser: Browser, name: string, phone = false) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: phone ? sizes[1] : sizes[0], hasTouch: phone, isMobile: phone, colorScheme: "dark" });
  await context.addInitScript(installPhase4PcProbe);
  await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
      const paint = canvas.getContext("2d")!; let frame = 0;
      const timer = setInterval(() => { paint.fillStyle = frame++ % 2 ? "#284d38" : "#385d48"; paint.fillRect(0, 0, 1280, 720); paint.fillStyle = "#fff"; paint.fillText(`Synthetic frame ${frame}`, 60, 60); }, 60);
      const stream = canvas.captureStream(15); stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
      return stream;
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  watchVoice(page, name);
  try {
    await page.goto("/"); await fillSignIn(page, name, password);
    // Authentication renders the shell before establish() has loaded its channels.
    // With eight live SFU peers, wait for bootstrap I/O rather than spending the
    // composer's five-second assertion budget on those requests.
    const bootstrap = ["/api/channels", "/api/members", "/api/notifications", "/api/servers"].map(path =>
      page.waitForResponse(response => new URL(response.url()).pathname === path));
    const [responses] = await Promise.all([Promise.all(bootstrap), logInButton(page).click()]);
    for (const response of responses) expect(response.ok(), `Bootstrap ${new URL(response.url()).pathname}`).toBe(true);
    await expect(page.getByTestId("screen-composer")).toBeVisible();
    return { page, context };
  } catch (error) {
    // A failed open() never reaches the caller's context list/finally.
    await context.close();
    throw error;
  }
}

async function closeContexts(contexts: BrowserContext[]) {
  for (const context of contexts) {
    await context.setOffline(false);
    const page = context.pages()[0];
    const leave = page?.locator(".hc-stagebar").getByRole("button", { name: "Leave", exact: true });
    if (leave && await leave.isVisible().catch(() => false)) await leave.click({ timeout: 5000 }).catch(() => {});
    await context.close();
  }
}

/** Observe an actual DOM arrival, then sample frames for a bounded 420ms. */
function arrivalFrames(page: Page, selector: string) {
  return page.evaluate(selector => new Promise<{ t: number; transform: string; opacity: number; properties: string[]; existingRows: { label: string | null; connected: boolean; transform: string; opacity: number; properties: string[] }[] }[]>(resolve => {
    // Capture exact nodes before the arrival, never classify concurrent new rows as existing.
    const existing = [...document.querySelectorAll(".hc-vrow")];
    const propertiesOf = (node: Element) => node.getAnimations().flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key))));
    const observer = new MutationObserver(scan);
    const timeout = setTimeout(() => { observer.disconnect(); resolve([]); }, 30000);
    function scan() {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return;
      observer.disconnect(); clearTimeout(timeout);
      const started = performance.now(), frames: { t: number; transform: string; opacity: number; properties: string[]; existingRows: { label: string | null; connected: boolean; transform: string; opacity: number; properties: string[] }[] }[] = [];
      const sample = () => {
        const style = getComputedStyle(element);
        const properties = propertiesOf(element);
        frames.push({ t: performance.now() - started, transform: style.transform, opacity: Number(style.opacity), properties,
          existingRows: existing.filter(node => node !== element).map(node => ({ label: node.querySelector(".hc-vrow__open")?.getAttribute("aria-label") ?? null,
            connected: node.isConnected, transform: getComputedStyle(node).transform, opacity: Number(getComputedStyle(node).opacity), properties: propertiesOf(node) })) });
        if (performance.now() - started < 420) requestAnimationFrame(sample); else resolve(frames);
      };
      requestAnimationFrame(sample);
    }
    observer.observe(document.body, { childList: true, subtree: true }); scan();
  }), selector);
}
async function recordMotion(name: string, frames: Awaited<ReturnType<typeof arrivalFrames>>, reduced = false) {
  await writeFile(resolve(directory, `${name}-frames.json`), JSON.stringify(frames, null, 2));
  expect(frames.length).toBeGreaterThan(2);
  expect(frames.at(-1)!.t).toBeLessThan(1500);
  for (const frame of frames) {
    expect(frame.properties.every(property => ["opacity", "transform"].includes(property))).toBe(true);
    if (reduced) {
      expect(frame.transform).toBe("none"); expect(frame.opacity).toBe(1); expect(frame.properties).toEqual([]);
      for (const row of frame.existingRows) {
        expect(row.connected).toBe(true); expect(row.transform).toBe("none"); expect(row.opacity).toBe(1); expect(row.properties).toEqual([]);
      }
    }
  }
  expect(frames.at(-1)!.opacity).toBe(1);
}

async function join(page: Page) {
  await openMenu(page);
  await page.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true }).click();
  const confirmation = page.getByTestId("voice-sheet");
  if (await confirmation.isVisible()) await confirmation.getByRole("button", { name: "Join voice", exact: true }).click();
  await expect(page.getByTestId("call-stage")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
}
const stage = (page: Page) => page.locator(".hc-stage.is-full");
const controls = (page: Page) => page.locator(".hc-stagebar");
/** Check the actual voice receiver, independently of the reserved screen-audio receiver.
 * CallMedia.share has its own output prefs (Tile.tsx); an HTML video tag can carry either kind. */
async function assertOwnerMutedForMe(page: Page, peer: string, away: boolean) {
  const media = await page.locator(`.hc-stage.${away ? "is-away" : "is-full"} video[data-peer-id="${peer}"]`).evaluateAll((nodes: HTMLVideoElement[]) => nodes.map(node => ({
    share: node.hasAttribute("data-share"), kind: node.dataset.mediaKind,
    muted: node.muted, volume: node.volume,
    tracks: (node.srcObject as MediaStream | null)?.getTracks().map(track => ({ kind: track.kind, state: track.readyState })) ?? [],
  })));
  await test.info().attach(`owner-output-${away ? "away" : "full"}`, { body: JSON.stringify(media, null, 2), contentType: "application/json" });
  // Exact counts prevent missing media or an unresolved peer/person mapping from passing.
  expect(media).toHaveLength(3);
  expect(media.filter(node => node.kind === "audio" && !node.share)).toEqual([
    { share: false, kind: "audio", muted: true, volume: 1, tracks: [{ kind: "audio", state: "live" }] },
  ]);
  expect(media.filter(node => node.kind === "audio" && node.share)).toEqual([
    { share: true, kind: "audio", muted: false, volume: 1, tracks: [{ kind: "audio", state: "live" }] },
  ]);
  expect(media.filter(node => node.kind === "video").map(node => node.tracks)).toEqual([[{ kind: "video", state: "live" }]]);
}
async function shot(page: Page, name: string) {
  if (process.env.HOUSECALL_PHASE4_SHOTS !== "1") return;
  const capture = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    launchT: (window as unknown as { __p4LaunchFrames?: { t: number }[] }).__p4LaunchFrames?.at(-1)?.t,
    splashOut: document.querySelector<HTMLElement>(".hc-splash")?.dataset.out,
  }));
  await page.screenshot({ path: resolve(directory, `${name}.png`), mask: [page.locator('input[type="password"], .hc-words, .hc-codefield, .hc-plates, .hc-qr:not(.is-hidden)')] });
  await writeFile(resolve(directory, `${name}-capture.json`), JSON.stringify(capture, null, 2));
}
async function geometry(page: Page) {
  return stage(page).locator(".hc-stage__grid > .hc-tile").evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
  }));
}
async function allVariants(page: Page, count: number) {
  for (const size of sizes) for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize(size); await page.emulateMedia({ colorScheme });
    // A resize across the phone breakpoint returns to the conversation with no drawer overlay.
    await expect(page.locator(".hc-shell")).toHaveAttribute("data-screen", "main");
    await expect(stage(page).locator(".hc-stage__grid")).toHaveAttribute("data-count", String(count));
    await expect.poll(async () => (await geometry(page)).length).toBe(count);
    await page.waitForTimeout(400); // bounded settling before geometry and screenshots
    const boxes = await geometry(page), grid = await stage(page).locator(".hc-stage__grid").boundingBox();
    expect(grid).not.toBeNull();
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(grid!.x - 1); expect(box.x + box.width).toBeLessThanOrEqual(grid!.x + grid!.width + 1);
      if (size.width > 760) expect(box.y + box.height).toBeLessThanOrEqual(grid!.y + grid!.height + 1);
    }
    if (size.width === 1280) {
      if (count === 1) expect(boxes[0].width).toBeLessThanOrEqual(640);
      if (count === 2) {
        const possible = Math.min(grid!.width, (grid!.height - 12) / 2 * 16 / 9, 640);
        expect(boxes[0].width).toBeGreaterThanOrEqual(Math.floor(possible) - 1);
        if (possible >= 540) expect(boxes[0].width).toBeGreaterThanOrEqual(540);
      }
      if (count === 4) { expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0); expect(boxes[2].y).toBeCloseTo(boxes[3].y, 0); expect(boxes[2].y).toBeGreaterThan(boxes[0].y); }
      const leave = await controls(page).getByRole("button", { name: "Leave", exact: true }).boundingBox();
      expect(leave?.width).toBe(60); expect(leave?.height).toBe(44);
    } else {
      await expect(controls(page).getByRole("button")).toHaveCount(4);
      await expect(controls(page).getByRole("button", { name: "Share screen", exact: true })).toHaveCount(0);
      if (count === 2) {
        expect(boxes[1].y - boxes[0].y - boxes[0].height).toBeCloseTo(8, 0);
        expect(boxes[0].y).toBeCloseTo(grid!.y, 0); expect(boxes[1].y + boxes[1].height).toBeCloseTo(grid!.y + grid!.height, 0);
      }
      if (count === 3) { expect(boxes[2].width).toBeCloseTo(grid!.width, 0); expect(boxes[0].width).toBeLessThan(boxes[2].width); }
      if (count === 9) {
        expect(Math.min(...boxes.map(box => box.height))).toBeGreaterThanOrEqual(136);
        expect(await stage(page).locator(".hc-stage__grid").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `stage-${count}-${size.width}-${colorScheme}`);
    await writeFile(resolve(directory, `geometry-${count}-${size.width}-${colorScheme}.json`), JSON.stringify({ grid, boxes }, null, 2));
  }
  await page.setViewportSize(sizes[0]);
}

test("real SFU grid: one, two, three, four and nine people at both sizes and themes", async ({ browser, request }) => {
  test.setTimeout(360000);
  const contexts: BrowserContext[] = [];
  try {
    const main = await open(browser, "p4_owner"); contexts.push(main.context); await join(main.page);
    await allVariants(main.page, 1);
    const camera = controls(main.page).getByRole("button", { name: "Camera on", exact: true });
    await expect(camera).toHaveAttribute("aria-pressed", "false"); await expect(camera).not.toHaveClass(/is-active/);
    await camera.click(); await expect(controls(main.page).getByRole("button", { name: "Camera off", exact: true })).toHaveClass(/is-lit/);
    await controls(main.page).getByRole("button", { name: "Camera off", exact: true }).click();
    for (let index = 1; index <= 8; index++) {
      const peer = await open(browser, `p4_${index}`); contexts.push(peer.context); await join(peer.page);
      await expect(stage(main.page).getByTestId("call-tile")).toHaveCount(index + 1, { timeout: 20000 });
      if ([2, 3, 4, 9].includes(index + 1)) await allVariants(main.page, index + 1);
    }
    await expect(main.page.locator(".hc-header__meta")).toContainText("9 inside");
    await expect(main.page.getByTestId("call-duration")).toBeVisible();
    await expect(controls(main.page).locator(".hc-avatar")).toHaveCount(0);
    for (const label of ["Search", "Pins", "Server settings"]) await expect(main.page.locator(".hc-center .hc-header").getByRole("button", { name: label, exact: true })).toBeVisible();
    await captureVoiceTrace(contexts, request, auth(owner), lounge, test.info(), "success");
  } catch (error) {
    // Snapshot before Leave/close destroys the missing peer's evidence. Preserve the original stack.
    await captureVoiceTrace(contexts, request, auth(owner), lounge, test.info(), "failure").catch(async () => {
      await test.info().attach("sfu-diagnostics-unavailable", { body: "Failure snapshot could not be written; original test error retained.", contentType: "text/plain" });
    });
    throw error;
  } finally { await closeContexts(contexts); }
});

test("desktop person card outside dismissal preserves focus, replacement and Search action", async ({ browser }) => {
  const { page, context } = await open(browser, "p4_owner");
  try {
    const people = page.getByTestId("people");
    const original = people.getByRole("button", { name: "p4_owner", exact: true });
    const replacement = people.getByRole("button", { name: "p4_1", exact: true });
    const card = page.getByTestId("person-card");
    const header = page.locator(".hc-center .hc-header");
    for (let cycle = 0; cycle < 3; cycle++) {
      await original.click();
      await expect(card).toHaveCount(1);
      await expect(card.getByRole("button", { name: "Edit profile", exact: true })).toBeFocused();
      await header.getByRole("heading", { level: 1 }).click();
      await expect(card).toHaveCount(0);
      await expect(original).toBeFocused();
    }
    await original.click();
    await expect(card.getByRole("button", { name: "Edit profile", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(original).toBeFocused();

    await original.click();
    await expect(card).toHaveAttribute("aria-label", "p4_owner");
    await replacement.click();
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("aria-label", "p4_1");
    await expect(card.getByRole("button", { name: "Message", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(replacement).toBeFocused();
    await expect(people).toBeVisible();

    await original.click();
    await expect(card).toBeVisible();
    // Assert the real outside action and its destination focus after dismissal.
    await header.getByRole("button", { name: "Search", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("screen-search")).toHaveCount(1);
    await expect(page.getByTestId("screen-search").getByRole("textbox", { name: "Search messages", exact: true })).toBeFocused();
    await expect(people).toHaveCount(0);
  } finally { await context.close(); }
});

test("real stream capture and Watch stream; person cards, touch cancellation, recovery and motion", async ({ browser, request }) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  try {
    const sharer = await open(browser, "p4_owner"), viewer = await open(browser, "p4_1"), phone = await open(browser, "p4_2", true);
    contexts.push(sharer.context, viewer.context, phone.context);
    await join(sharer.page);
    // Local stage live does not mean the sidebar's asynchronous room roster has arrived.
    const ownerRow = sharer.page.locator(".hc-vrow:has(.hc-vrow__open[aria-label^='p4_owner'])");
    await expect(ownerRow).toHaveCount(1);
    await expect(ownerRow).not.toHaveClass(/is-entering/);
    await expect(ownerRow).toHaveCSS("transform", "none");
    const joinedFrames = arrivalFrames(sharer.page, ".hc-vrow:has(.hc-vrow__open[aria-label^='p4_1'])");
    await join(viewer.page);
    const joined = await joinedFrames; await recordMotion("voice-join", joined);
    for (const frame of joined) {
      expect(frame.existingRows).toHaveLength(1);
      for (const row of frame.existingRows) {
        expect(row.label).toMatch(/^p4_owner/); expect(row.connected).toBe(true);
        expect(row.transform).toBe("none"); expect(row.opacity).toBe(1); expect(row.properties).toEqual([]);
      }
    }
    const streamFrames = arrivalFrames(viewer.page, ".hc-tile--stream");
    await controls(sharer.page).getByRole("button", { name: "Mute", exact: true }).click();
    await controls(sharer.page).getByRole("button", { name: "Share screen", exact: true }).click();
    await recordMotion("stream-enter", await streamFrames);
    const screen = stage(viewer.page).locator(".hc-tile--stream");
    await expect(screen).toHaveCount(1); await expect(stage(viewer.page).getByTestId("call-tile")).toHaveCount(3);
    await expect(stage(viewer.page).locator(".hc-tile:not(.hc-tile--stream)").filter({ hasText: "p4_owner" }).locator(".hc-livepill")).toBeVisible();
    await expect.poll(() => screen.locator("video").first().evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 30000 }).toBeGreaterThan(3);
    // Local names open the shared card and Escape returns focus to the exact trigger.
    const ownerPeer = await screen.getAttribute("data-peer-id");
    expect(ownerPeer).not.toBeNull();
    const tileName = screen.locator(".hc-tile__name"); await tileName.click();
    const card = viewer.page.getByTestId("person-card"); await expect(card).toBeVisible(); await expect(card.getByRole("slider")).toBeVisible();
    await expect(card).toHaveCSS("transform", "none", { timeout: 3000 });
    const box = await card.boundingBox(); expect(box!.width).toBe(280); expect(box!.x).toBeGreaterThanOrEqual(8); expect(box!.x + box!.width).toBeLessThanOrEqual(1272);
    await card.getByRole("switch").check();
    expect(await viewer.page.evaluate(() => JSON.parse(localStorage.getItem("hc.voicePrefs") ?? "{}")[Object.keys(JSON.parse(localStorage.getItem("hc.voicePrefs") ?? "{}"))[0]].muted)).toBe(true);
    await shot(viewer.page, "person-card-1280-dark");
    await viewer.page.keyboard.press("Escape"); await expect(card).toHaveCount(0); await expect(tileName).toBeFocused();
    await assertOwnerMutedForMe(viewer.page, ownerPeer!, false);
    await viewer.page.getByRole("tab", { name: "People", exact: true }).click();
    const peopleRow = viewer.page.getByTestId("people").getByRole("button", { name: "p4_owner", exact: true });
    await peopleRow.click(); await expect(card).toBeVisible();
    await viewer.page.keyboard.press("Escape"); await expect(peopleRow).toBeFocused();
    await peopleRow.click();
    const ownerTrackIds = () => viewer.page.getByTestId("call-stage").locator(`video[data-peer-id="${ownerPeer}"]`).evaluateAll((nodes: HTMLVideoElement[]) =>
      nodes.flatMap(node => (node.srcObject as MediaStream | null)?.getTracks().map(track => track.id) ?? []).sort());
    const retainedOwnerTracks = await ownerTrackIds();
    expect(retainedOwnerTracks).toHaveLength(3);
    await card.getByRole("button", { name: "Message", exact: true }).click();
    await expect(card).toHaveCount(0); await expect(viewer.page.locator(".hc-center .hc-header h1")).toHaveText("p4_owner");
    await expect(viewer.page.getByTestId("call-dock")).toBeVisible();
    await expect(viewer.page.locator(".hc-stage.is-away")).toHaveAttribute("data-phase", "live");
    await assertOwnerMutedForMe(viewer.page, ownerPeer!, true);
    expect(await ownerTrackIds()).toEqual(retainedOwnerTracks);
    // The same established call survives navigating to the DM and back.
    await viewer.page.getByTestId("call-dock").getByRole("button", { name: "Open Lounge", exact: true }).click();
    await expect(stage(viewer.page)).toHaveAttribute("data-phase", "live");
    await expect(screen).toHaveAttribute("data-peer-id", ownerPeer!);
    await assertOwnerMutedForMe(viewer.page, ownerPeer!, false);
    expect(await ownerTrackIds()).toEqual(retainedOwnerTracks);
    // Phone sidebar short tap opens a card without call-only preferences (not joined).
    await openMenu(phone.page);
    const liveRow = phone.page.getByTestId("voice-person").filter({ has: phone.page.locator(".hc-livepill") }).first();
    const livePerson = liveRow.locator(".hc-vrow__open");
    await livePerson.tap(); await expect(phone.page.getByTestId("person-card")).toBeVisible();
    await expect(phone.page.getByTestId("person-card").getByRole("slider")).toHaveCount(0);
    await shot(phone.page, "person-card-390-dark");
    await phone.page.keyboard.press("Escape"); await expect(livePerson).toBeFocused();
    // Pointer sequences run on real DOM elements; the actual 450ms controller handles them.
    const point = (await livePerson.boundingBox())!;
    const down = { pointerType: "touch", pointerId: 41, button: 0, clientX: point.x + 20, clientY: point.y + 20 };
    await livePerson.dispatchEvent("pointerdown", down); await phone.page.waitForTimeout(200);
    await livePerson.dispatchEvent("pointermove", { ...down, clientX: down.clientX + 8 }); await phone.page.waitForTimeout(320);
    await expect(phone.page.getByTestId("stream-preview")).toHaveCount(0); await livePerson.dispatchEvent("pointerup", down);
    await livePerson.dispatchEvent("pointerdown", down); await livePerson.dispatchEvent("pointercancel", down); await phone.page.waitForTimeout(480);
    await expect(phone.page.getByTestId("stream-preview")).toHaveCount(0);
    await livePerson.dispatchEvent("pointerdown", down); await phone.page.waitForTimeout(480); await livePerson.dispatchEvent("pointerup", down); await livePerson.dispatchEvent("click");
    await expect(phone.page.getByTestId("stream-preview")).toBeVisible(); await expect(phone.page.getByTestId("person-card")).toHaveCount(0);
    await shot(phone.page, "longpress-preview-390-dark");
    await sharer.page.emulateMedia({ reducedMotion: "reduce" });
    const reducedFrames = arrivalFrames(sharer.page, ".hc-vrow:has(.hc-vrow__open[aria-label^='p4_2'])");
    await phone.page.getByTestId("stream-preview").getByRole("button", { name: "Watch stream", exact: true }).click();
    await recordMotion("voice-join-reduced", await reducedFrames, true);
    await expect(stage(phone.page).locator(".hc-stage__spot .hc-tile--stream")).toBeVisible({ timeout: 30000 });
    await expect(stage(phone.page).locator(".hc-stage__spot .hc-tile__pin")).toBeFocused();
    await shot(phone.page, "watch-focused-390-dark");
    await phone.page.keyboard.press("Escape"); await expect(stage(phone.page).locator(".hc-stage__grid")).toBeVisible();
    await expect(stage(phone.page).locator(".hc-tile--stream .hc-tile__pin")).toBeFocused();
    await shot(phone.page, "watch-focus-return-390-dark");
    // Existing signaling is actually interrupted. RTC media and the chosen mute state stay mounted.
    await controls(viewer.page).getByRole("button", { name: "Mute", exact: true }).click();
    const before = await geometry(viewer.page);
    await viewer.context.setOffline(true);
    await expect(viewer.page.locator(".hc-header__meta")).toContainText("Reconnecting", { timeout: 30000 });
    await expect(viewer.page.getByTestId("call-dock").locator(".hc-signal")).toHaveAttribute("data-busy", "");
    await expect(controls(viewer.page).getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await geometry(viewer.page)).toEqual(before);
    await shot(viewer.page, "reconnecting-1280-dark");
    await viewer.context.setOffline(false);
    await expect(viewer.page.locator(".hc-header__meta")).toContainText("3 inside", { timeout: 30000 });
    // Real browser tracks; deterministic media-state notification is NOT an actual ICE outage.
    const microphoneEnabled = () => viewer.page.evaluate(() => (window as unknown as { __phase4Peers: RTCPeerConnection[] }).__phase4Peers
      .flatMap(peer => peer.getSenders()).filter(sender => sender.track?.kind === "audio").map(sender => sender.track!.enabled));
    const changeAudio = async (dock = false) => {
      await (dock ? viewer.page.getByTestId("call-dock") : controls(viewer.page)).getByRole("button", { name: "Unmute", exact: true }).click();
      await expect.poll(microphoneEnabled).toEqual([true]);
      await controls(viewer.page).getByRole("button", { name: "Deafen", exact: true }).click();
      await expect.poll(microphoneEnabled).toEqual([false]);
      await controls(viewer.page).getByRole("button", { name: "Undeafen", exact: true }).click();
      await expect.poll(microphoneEnabled).toEqual([true]);
      await viewer.page.keyboard.press("Control+Shift+M");
      await expect.poll(microphoneEnabled).toEqual([false]);
    };
    await viewer.context.setOffline(true);
    await expect(viewer.page.locator(".hc-header__meta")).toContainText("Reconnecting", { timeout: 30000 });
    await changeAudio(true);
    await viewer.context.setOffline(false);
    await expect(viewer.page.locator(".hc-header__meta")).toContainText("3 inside", { timeout: 30000 });
    await viewer.page.evaluate(() => {
      const peer = (window as unknown as { __phase4Peers: RTCPeerConnection[] }).__phase4Peers.find(peer => peer.connectionState === "connected")!;
      Object.defineProperty(peer, "connectionState", { configurable: true, value: "disconnected" });
      peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect(stage(viewer.page)).toHaveAttribute("data-phase", "connecting");
    await changeAudio();
    await viewer.page.evaluate(() => {
      const peer = (window as unknown as { __phase4Peers: RTCPeerConnection[] }).__phase4Peers.find(peer => peer.connectionState === "disconnected")!;
      Reflect.deleteProperty(peer, "connectionState"); peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect(stage(viewer.page)).toHaveAttribute("data-phase", "live");
    await expect.poll(microphoneEnabled).toEqual([false]);
    // Close the actual receiver peer, then deliver its state notification. No fake CallStore/roster snapshot.
    await viewer.page.evaluate(() => {
      const peer = (window as unknown as { __phase4Peers: RTCPeerConnection[] }).__phase4Peers.find(peer => peer.connectionState === "connected")!;
      peer.close(); peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect(stage(viewer.page)).toHaveAttribute("data-phase", "failed");
    await expect(stage(viewer.page)).toContainText("Couldn't join Lounge");
    await expect(controls(viewer.page)).toHaveCount(0);
    await shot(viewer.page, "failed-1280-dark");
    await stage(viewer.page).getByRole("button", { name: "Try again", exact: true }).click();
    await expect(stage(viewer.page)).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    await expect(stage(viewer.page).locator(".hc-tile--stream video").first()).toBeAttached();
    await sharer.page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await sharer.page.locator(".hc-vrow, .hc-livepill").evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 0))).toBe(true);
    // Context menu still opens preview; click outside the desktop card closes and restores focus.
    const desktopPerson = sharer.page.getByTestId("voice-person").filter({ hasText: "p4_owner" }).locator(".hc-vrow__open");
    await desktopPerson.click({ button: "right" }); await expect(sharer.page.getByTestId("stream-preview")).toBeVisible(); await sharer.page.keyboard.press("Escape");
    await desktopPerson.click(); await expect(sharer.page.getByTestId("person-card").getByRole("button", { name: "Edit profile", exact: true })).toBeVisible();
    await expect(sharer.page.getByTestId("person-card").getByRole("button", { name: "Message", exact: true })).toHaveCount(0);
    await sharer.page.getByTestId("person-card").getByRole("button", { name: "Edit profile", exact: true }).click();
    await expect(sharer.page.getByTestId("screen-settings").getByRole("textbox", { name: "Display name", exact: true })).toBeVisible();
    await sharer.page.keyboard.press("Escape"); await expect(stage(sharer.page)).toHaveAttribute("data-phase", "live");
    await desktopPerson.click();
    await sharer.page.locator(".hc-center .hc-header h1").click(); await expect(sharer.page.getByTestId("person-card")).toHaveCount(0); await expect(desktopPerson).toBeFocused();
    await shot(sharer.page, "stream-grid-1280-dark");
    // Tile caption and edge use the supplied tokens; speaking can only change edge opacity.
    const edge = await stage(sharer.page).getByTestId("call-tile").first().evaluate(node => ({
      transition: getComputedStyle(node, "::after").transitionProperty,
      font: getComputedStyle(node.querySelector("figcaption")!).fontSize,
    }));
    expect(edge.transition).toBe("opacity");
    const removedRows = sharer.page.evaluate(() => new Promise<{ connected: boolean; leaving: boolean }[]>(resolve => {
      const records: { connected: boolean; leaving: boolean }[] = [];
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) for (const node of mutation.removedNodes) if (node instanceof Element && node.matches(".hc-vrow")) records.push({ connected: node.isConnected, leaving: node.classList.contains("is-leaving") });
        if (records.length) { observer.disconnect(); resolve(records); }
      });
      observer.observe(document.querySelector(".hc-channels")!, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(records); }, 30000);
    }));
    await controls(viewer.page).getByRole("button", { name: "Leave", exact: true }).click();
    const observed = await removedRows; expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(record => !record.connected && !record.leaving)).toBe(true);
    await writeFile(resolve(directory, "leave-immediate.json"), JSON.stringify(observed, null, 2));
    await captureVoiceTrace(contexts, request, auth(owner), lounge, test.info(), "success");
  } catch (error) {
    await captureVoiceTrace(contexts, request, auth(owner), lounge, test.info(), "failure").catch(async () => {
      await test.info().attach("sfu-diagnostics-unavailable", { body: "Failure snapshot could not be written; original test error retained.", contentType: "text/plain" });
    });
    throw error;
  } finally { await closeContexts(contexts); }
});

test("phone message tray never moves messages; selection, tap-away and reduced motion", async ({ browser }) => {
  const { page, context } = await open(browser, "p4_owner", true);
  page.setDefaultTimeout(15000);
  try {
    await send(page, "phase4 first message"); await send(page, "phase4 second message");
    const first = row(page, "phase4 first message"), second = row(page, "phase4 second message");
    const before = { first: await first.boundingBox(), second: await second.boundingBox() };
    for (const colorScheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme }); await shot(page, `message-tray-before-390-${colorScheme}`); }
    await first.locator(".hc-md").tap({ timeout: 15000 });
    const tray = first.getByRole("toolbar", { name: "Messages" }); await expect(tray).toBeVisible(); await expect(tray.getByRole("button")).toHaveCount(6);
    for (const text of ["Reply", "React", "Pin", "Preview", "Edit", "Unsend"]) await expect(tray.getByText(text, { exact: true })).toBeVisible();
    const movement = await page.evaluate(async () => {
      const frames: { t: number; boxes: { x: number; y: number; width: number; height: number }[] }[] = [], start = performance.now();
      while (performance.now() - start < 260) {
        const boxes = [...document.querySelectorAll(".hc-msg")].map(node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; });
        frames.push({ t: performance.now() - start, boxes }); await new Promise(requestAnimationFrame);
      }
      return frames;
    });
    expect({ first: await first.boundingBox(), second: await second.boundingBox() }).toEqual(before);
    for (const frame of movement) expect(frame.boxes).toEqual(movement[0].boxes);
    for (const size of sizes.filter(size => size.width === 390)) for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme }); await shot(page, `message-tray-${size.width}-${colorScheme}`);
    }
    await second.locator(".hc-md").tap({ timeout: 15000 }); await expect(second.getByRole("toolbar")).toBeVisible();
    await expect(page.locator(".hc-msg.is-open")).toHaveCount(1); await expect(first).not.toHaveClass(/is-open/);
    await expect(second.getByRole("toolbar")).toHaveCSS("transition-duration", "0s");
    expect({ first: await first.boundingBox(), second: await second.boundingBox() }).toEqual(before);
    await test.step("tap visible neutral channel glyph", () => tapAwayFromMessageTray(page)); await expect(page.locator(".hc-msg.is-open")).toHaveCount(0);
    expect({ first: await first.boundingBox(), second: await second.boundingBox() }).toEqual(before);
    await page.emulateMedia({ reducedMotion: "reduce" }); await first.locator(".hc-md").tap({ timeout: 15000 }); await expect(tray).toHaveCSS("transition-duration", "0s");
    await page.keyboard.press("Escape"); await expect(page.locator(".hc-msg.is-open")).toHaveCount(0);
    const composer = page.locator(".hc-composer__row"); await expect(composer).toHaveCSS("border-top-width", "0px"); await expect(composer).not.toHaveCSS("box-shadow", "none");
    await writeFile(resolve(directory, "message-tray-frames.json"), JSON.stringify(movement, null, 2));
  } finally { await context.close(); }
});

test("Splash: fast skip, slow real session restore, one mark, landing, phone fade and reduced motion", async ({ browser, request }) => {
  test.setTimeout(180000);
  // Fast browser first screen: no stored session and no flash of the mark.
  const fast = await browser.newContext({ viewport: sizes[0] });
  const fastPage = await fast.newPage();
  await fastPage.addInitScript(() => {
    Object.assign(window, { __p4SplashSeen: false });
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && (node.matches(".hc-splash") || node.querySelector(".hc-splash"))) Object.assign(window, { __p4SplashSeen: true }); }).observe(document, { childList: true, subtree: true });
  });
  await fastPage.goto("/"); await expect(fastPage.getByTestId("screen-welcome")).toBeVisible(); await fastPage.waitForTimeout(400);
  expect(await fastPage.evaluate(() => (window as unknown as { __p4SplashSeen: boolean }).__p4SplashSeen)).toBe(false);
  await fast.close();

  const seed = new Uint8Array(32).fill(84);
  const provisioning = await (await request.post("/api/login", { data: { username: "p4_8", password, device_name: "phase4 key fixture" } })).json();
  expect((await request.put("/api/me/keys", { headers: auth(provisioning), data: { identity_key: b64u(publicIdentityKey(seed)) } })).ok()).toBe(true);
  expect((await request.put("/api/me/key-backup", { headers: auth(provisioning), data: { key_backup: b64u(sealBackup(seed, 1)) } })).ok()).toBe(true);
  const seedText = b64u(seed);
  const launchCases = sizes.flatMap(size => (["light", "dark"] as const).flatMap(colorScheme => [false, true].map(reduced => ({ size, colorScheme, reduced, statusOnly: false }))));
  launchCases.push({ size: sizes[0], colorScheme: "dark", reduced: false, statusOnly: true });
  for (const { size, colorScheme, reduced, statusOnly } of launchCases) {
    const response = await request.post("/api/login", { data: { username: "p4_8", password, device_name: "phase4 restore presentation" } });
    expect(response.ok()).toBe(true); const session: Session = await response.json();
    const context = await browser.newContext({ viewport: size, colorScheme, reducedMotion: reduced ? "reduce" : "no-preference" });
    try {
      // This stand-in supplies the OS session boundary only. Session probe, refresh and all app rendering are real.
      // The synthetic account has a real matching published key and backup; no onboarding overlay covers the entrance.
      // It proves no Keychain/Keystore/unlock behavior.
      await context.addInitScript(({ session, seedText }) => {
        let release: (() => void) | undefined;
        const stored = new Promise<void>(resolve => { release = resolve; });
        Object.assign(window, { __p4ReleaseRestore: () => release?.(), __p4LaunchFrames: [] });
        Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command.endsWith("|list")) return { origins: [location.origin] };
          if (command.endsWith("|get")) { await stored; return { session: { ...session, username: session.user.username } }; }
          if (command.endsWith("|identity_get")) return { identity: { seed: seedText, recovery_rev: 1, confirmed: true } };
          if (command.endsWith("|bindings_get")) return { bindings: [] };
          if (command.endsWith("|pins_get")) return { pins: [] };
          if (command.endsWith("|remove")) return { ok: true };
          if (command.endsWith("|bindings_set") || command.endsWith("|pins_set") || command.endsWith("|set") || command.endsWith("|sensitive_surface")) return { ok: true };
          if (command === "native_auth") return args.action === "status" ? { platform: "desktop" } : {};
          if (command === "native_push") return { supported: false, configured: false, enabled: false, permissionGranted: false };
          if (command === "scheme_invite_take") return {};
          throw new Error("Unavailable in session presentation fixture");
        } } });
        const frames: { t: number; marks: number; out?: string; intro: boolean }[] = [];
        Object.assign(window, { __p4LaunchFrames: frames });
        let start: number | undefined;
        // Start at the root's DOM commit, before paint. The first rAF can be
        // delayed by layout/module work and is not the splash's mount time.
        const mountObserver = new MutationObserver(() => {
          if (document.querySelector(".hc-root")) {
            start = performance.now();
            mountObserver.disconnect();
          }
        });
        mountObserver.observe(document, { childList: true, subtree: true });
        const sample = () => {
          if (start !== undefined) {
            const marks = [...document.querySelectorAll(".hc-logo")].filter(node => {
              const box = node.getBoundingClientRect(), style = getComputedStyle(node);
              const mark = node.closest(".hc-splash__mark");
              return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && (!mark || Number(getComputedStyle(mark).opacity) > 0) && box.width > 0 && box.right > 0 && box.left < innerWidth;
            }).length;
            const splash = document.querySelector<HTMLElement>(".hc-splash");
            frames.push({ t: performance.now() - start, marks, out: splash?.dataset.out, intro: !!splash?.hasAttribute("data-intro") });
          }
          if (start === undefined || performance.now() - start < 7000) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { session, seedText });
      const page = await context.newPage(); await page.goto("/", { waitUntil: "commit" });
      const prefix = `splash-${size.width}-${colorScheme}${reduced ? "-reduced" : ""}${statusOnly ? "-status-wait" : ""}`;
      const at = (time: number) => page.waitForFunction(time => {
        const frames = (window as unknown as { __p4LaunchFrames?: { t: number }[] }).__p4LaunchFrames;
        return !!frames?.length && frames.at(-1)!.t >= time;
      }, time);
      if (!statusOnly) { await at(200); await shot(page, `${prefix}-t200`); }
      await expect(page.getByTestId("splash")).toBeVisible();
      await at(460);
      const splash = page.getByTestId("splash");
      if (reduced) expect(await splash.locator(".hc-logo").evaluate(node => getComputedStyle(node).transform)).toBe("none");
      await shot(page, `${prefix}-t460`);
      if (statusOnly) {
        await at(4200); await expect(splash.locator(".hc-splash__status")).toBeVisible();
        await shot(page, "splash-status-1280-dark");
      }
      await page.evaluate(() => (window as unknown as { __p4ReleaseRestore: () => void }).__p4ReleaseRestore());
      if (statusOnly) await expect(splash).toHaveAttribute("data-out", "fly", { timeout: 10000 });
      if (!statusOnly) for (const time of [620, 800, 1000, 1180]) { await at(time); await shot(page, `${prefix}-t${time}`); }
      await expect(splash).toHaveCount(0);
      await expect(page.locator(".hc-shell")).not.toHaveAttribute("data-enter", "");
      await expect(page.locator(".hc-center .hc-header h1")).toHaveText("general");
      const frames = await page.evaluate(() => (window as unknown as { __p4LaunchFrames: { t: number; marks: number; out?: string; intro: boolean }[] }).__p4LaunchFrames);
      await writeFile(resolve(directory, `${prefix}-frames.json`), JSON.stringify(frames, null, 2));
      expect(frames.length).toBeGreaterThan(4);
      expect(frames.some(frame => frame.out === (size.width === 1280 && !reduced ? "fly" : "fade"))).toBe(true);
      expect(frames.filter(frame => frame.t < 280).every(frame => frame.marks === 0)).toBe(true);
      expect(frames.every(frame => frame.marks <= 1)).toBe(true);
      if (size.width === 1280 && !reduced) expect(frames.filter(frame => frame.out === "fly").every(frame => frame.marks === 1)).toBe(true);
      // Signing out and back in within this module lifetime must not show Splash again.
      await page.getByRole("button", { name: "Server settings", exact: true }).click();
      await page.getByTestId("screen-settings").getByRole("button", { name: "Profile", exact: true }).click();
      await page.getByTestId("screen-settings").getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByTestId("screen-sign-in").or(page.getByTestId("screen-welcome"))).toBeVisible();
      await expect(page.getByTestId("splash")).toHaveCount(0);
      await signIn(page, "p4_8", password);
      await page.waitForTimeout(400); await expect(page.getByTestId("splash")).toHaveCount(0);
    } finally { await context.close(); }
  }
});


test("People header to person to Message closes the sheet on phone and tablet", async ({ browser }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 900, height: 900 }]) {
    const context = await browser.newContext({ viewport, hasTouch: true });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      await page.goto("/"); await signIn(page, "p4_1", password);
      await page.locator(".hc-center .hc-header").getByRole("button", { name: "People", exact: true }).click();
      await page.getByTestId("people").getByRole("button", { name: "p4_owner", exact: true }).click();
      await page.getByTestId("person-card").getByRole("button", { name: "Message", exact: true }).click();
      await expect(page.locator(".hc-center .hc-header h1")).toHaveText("p4_owner");
      await expect(page.locator(".hc-scrim")).toHaveCount(0);
      const composer = page.getByTestId("screen-composer").getByLabel("Message", { exact: true });
      await composer.click(); await composer.fill("reachable destination"); await expect(composer).toBeFocused();
    } finally { await context.close(); }
  }
});
