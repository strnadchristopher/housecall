import { test, expect, devices } from "@playwright/test";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { fillSignIn, logInButton } from "./helpers";

/** A phone shows the conversation list first, so sign in and then open the general channel. */
async function phoneSignIn(page: Page, username: string, password: string) {
  await fillSignIn(page, username, password);
  await logInButton(page).click();
  await openGeneral(page);
}
async function openGeneral(page: Page) {
  const list = page.getByRole("button", { name: "Open general", exact: true });
  const composer = page.getByTestId("screen-composer");
  await expect(list.or(composer).first()).toBeVisible();
  if (!(await composer.isVisible()) && (await list.isVisible())) await list.click();
  await expect(composer).toBeVisible();
}

/** A solid-colour PNG, built here so the fixture needs no file. */
function photo(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9c)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("a snap opens once per recipient, closes after ten seconds and is then gone", async ({ browser, request }) => {
  test.setTimeout(90000);
  const password = "synthetic snap password 123";
  const headers = (s: { token: string; device_key: string }) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });
  const owner = await (await request.post("/api/setup", { data: { username: "snap_sender", password, setup_token: "test-setup-token-at-least-32-characters", device_name: "snap fixture" } })).json();
  const invitation = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
  const friend = await (await request.post("/api/invites/accept", { data: { token: invitation.token, username: "snap_friend", password, device_name: "snap fixture" } })).json();

  const { defaultBrowserType: _ignored, ...phone } = devices["iPhone 13"];
  const sender = await (await browser.newContext(phone)).newPage();
  const receiver = await (await browser.newContext(phone)).newPage();
  sender.setDefaultTimeout(15000);
  receiver.setDefaultTimeout(15000);
  const opens: string[] = [];
  receiver.on("request", r => { if (r.method() === "POST" && /^\/api\/snaps\/[^/]+\/open$/.test(new URL(r.url()).pathname)) opens.push(r.url()); });
  await receiver.clock.install();

  await sender.goto("/");
  await phoneSignIn(sender, "snap_sender", password);
  await receiver.goto("/");
  await phoneSignIn(receiver, "snap_friend", password);

  // The camera button is on the phone composer; its input takes the photo straight from the camera.
  const composer = sender.getByTestId("screen-composer");
  await expect(composer.getByRole("button", { name: "Take a snap", exact: true })).toBeVisible();
  await composer.getByTestId("snap-capture").setInputFiles({ name: "camera.png", mimeType: "image/png", buffer: photo(96, 128) });
  await expect(sender.getByTestId("snap-preview")).toBeVisible();
  await sender.getByRole("button", { name: "Send as snap", exact: true }).click();
  await expect(sender.getByTestId("snap-preview")).toBeHidden();
  const sent = sender.getByTestId("snap-tile");
  await expect(sent).toContainText("Opened by 0 of 1");

  // The recipient sees a tile, never the photo, and the normal download route refuses it.
  const tile = receiver.getByTestId("snap-tile");
  await expect(tile).toContainText("Tap to view");
  await expect(receiver.getByTestId("snap-image")).toHaveCount(0);
  const list = await (await request.get("/api/channels/general/messages", { headers: headers(friend) })).json();
  const attachment = list.messages.at(-1).attachments[0];
  expect(attachment.kind).toBe("snap");
  expect(JSON.stringify(attachment)).not.toContain("/api/");
  expect((await request.get(`/api/media/${attachment.id}`, { headers: headers(friend) })).status()).toBe(403);

  await tile.click();
  const image = receiver.getByTestId("snap-image");
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(96);
  expect(opens).toHaveLength(1);
  // The viewer covers the whole app (nothing paints over it, not even the composer's send arrow),
  // is opaque, and the small photo is scaled up to the screen instead of sitting at its pixel size.
  const covered = await receiver.evaluate(() => {
    const viewer = document.querySelector(".hc-snapview");
    const spots = [[innerWidth - 24, innerHeight - 24], [24, innerHeight - 24], [innerWidth / 2, innerHeight - 8]];
    return { parent: viewer?.closest(".hc-presence")?.parentElement === document.body, hits: spots.map(([x, y]) => !!viewer?.contains(document.elementFromPoint(x, y))), background: viewer ? getComputedStyle(viewer).backgroundColor : "" };
  });
  expect(covered.parent).toBe(true);
  expect(covered.hits).toEqual([true, true, true]);
  expect(covered.background).toMatch(/^rgb\(/);
  expect((await image.boundingBox())!.width).toBeGreaterThan(300);
  await receiver.clock.fastForward(10_500);
  await expect(receiver.getByRole("dialog", { name: "Snap" })).toBeHidden();

  // Reloading shows it opened, with nothing left to tap.
  await receiver.reload();
  await phoneSignIn(receiver, "snap_friend", password);
  const after = receiver.getByTestId("snap-tile");
  await expect(after).toContainText("Opened");
  await expect(after).toHaveAttribute("data-state", "opened");
  await expect(receiver.getByRole("button", { name: /Snap, Tap to view/ })).toHaveCount(0);
  expect(opens).toHaveLength(1);
  expect((await request.post(`/api/snaps/${attachment.id}/open`, { headers: headers(friend) })).status()).toBe(410);

  // The sender sees that it was opened, and the bytes are gone from the server.
  await expect(sent).toContainText("Opened by 1 of 1");
  expect((await request.post(`/api/snaps/${attachment.id}/open`, { headers: headers(owner) })).status()).toBe(403);

  // Cancel in the preview sends nothing.
  await composer.getByTestId("snap-capture").setInputFiles({ name: "camera.png", mimeType: "image/png", buffer: photo(48, 48) });
  await expect(sender.getByTestId("snap-preview")).toBeVisible();
  await sender.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sender.getByTestId("snap-preview")).toBeHidden();
  await expect(sender.getByTestId("snap-tile")).toHaveCount(1);

  // A tap anywhere closes a snap before the ten seconds are up, and the photo is not kept.
  await composer.getByTestId("snap-capture").setInputFiles({ name: "camera.png", mimeType: "image/png", buffer: photo(48, 48) });
  await sender.getByRole("button", { name: "Send as snap", exact: true }).click();
  await expect(sender.getByTestId("snap-tile")).toHaveCount(2);
  await expect(receiver.getByTestId("snap-tile")).toHaveCount(2);
  await receiver.getByRole("button", { name: /Snap, Tap to view/ }).click();
  await expect(receiver.getByTestId("snap-image")).toBeVisible();
  await receiver.getByRole("dialog", { name: "Snap" }).click({ position: { x: 20, y: 300 } });
  await expect(receiver.getByRole("dialog", { name: "Snap" })).toBeHidden();
  await expect(receiver.getByTestId("snap-image")).toHaveCount(0);
  expect(opens).toHaveLength(2);
});
