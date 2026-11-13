import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";

const password = "synthetic channel password 123";
const setupToken = "test-setup-token-at-least-32-characters";
const headers = (s: { token: string; device_key: string }) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });

test("voice channels are their own group; one click joins, everyone sees who is inside", async ({ browser, request }) => {
  test.setTimeout(150000);
  const owner = await (await request.post("/api/setup", { data: { username: "vc_owner", password, setup_token: setupToken, device_name: "vc fixture" } })).json();
  const me = await (await request.get("/api/me", { headers: headers(owner) })).json();
  test.skip(me.capabilities.voice !== true, "SFU transport not configured in this backend binary");
  const invitation = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
  expect((await request.post("/api/invites/accept", { data: { token: invitation.token, username: "vc_bob", password, device_name: "vc fixture" } })).ok()).toBeTruthy();

  const open = async (name: string): Promise<Page> => {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto("/");
    await signIn(page, name, password);
    return page;
  };
  const [ownerPage, bob] = [await open("vc_owner"), await open("vc_bob")];

  // Two groups; Lounge exists on every server; a text channel has no call bar.
  for (const page of [ownerPage, bob]) {
    await expect(page.getByRole("heading", { name: "Text channels" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Voice channels" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Lounge", exact: true })).toBeVisible();
    await expect(page.getByTestId("call-bar")).toHaveCount(0);
  }
  // Only the owner gets the plus buttons.
  await expect(ownerPage.getByRole("button", { name: "Create voice channel" })).toBeVisible();
  await expect(bob.getByRole("button", { name: "Create voice channel" })).toHaveCount(0);

  // One click joins and rings nobody.
  await ownerPage.getByRole("button", { name: "Open Lounge", exact: true }).click();
  await expect(ownerPage.getByTestId("call-stage")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await expect(bob.getByTestId("incoming-call")).toHaveCount(0);

  // Bob, outside the call, sees who is inside, with a count.
  const people = bob.getByRole("list", { name: "In Lounge" });
  await expect(people.getByRole("button", { name: "vc_owner", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(bob.getByLabel("1 inside")).toBeVisible();

  // A local change is sent and shown to others.
  await ownerPage.getByTestId("call-bar").getByRole("button", { name: "Mute", exact: true }).first().click();
  await expect(people.getByRole("button", { name: "vc_owner, muted", exact: true })).toBeVisible({ timeout: 15000 });

  // Going live shows the LIVE mark, which opens the preview with a way in.
  await request.put(`/api/channels/${(await (await request.get("/api/channels", { headers: headers(owner) })).json()).channels.find((c: { name: string }) => c.name === "Lounge").id}/voice/state`, {
    headers: headers(owner), data: { muted: true, deafened: false, camera: false, sharing: true },
  });
  const live = bob.getByRole("button", { name: "vc_owner is live. Preview the stream" });
  await expect(live).toBeVisible({ timeout: 15000 });
  await live.click();
  await expect(bob.getByTestId("stream-preview")).toBeVisible();
  await expect(bob.getByTestId("stream-preview").getByRole("button", { name: "Watch stream" })).toBeVisible();
  await bob.keyboard.press("Escape");
  await expect(bob.getByTestId("stream-preview")).toHaveCount(0);

  // Bob joins from the sidebar: the stage opens and the room shows both.
  await bob.getByRole("button", { name: "Open Lounge", exact: true }).click();
  await expect(bob.getByTestId("call-stage")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await expect(bob.getByLabel("2 inside")).toBeVisible({ timeout: 15000 });

  // Leaving empties the row for everyone.
  await ownerPage.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).first().click();
  await expect(bob.getByLabel("1 inside")).toBeVisible({ timeout: 15000 });

  // The owner creates a voice channel from the plus button; it arrives for everyone.
  await ownerPage.getByRole("button", { name: "Create voice channel" }).click();
  const dialog = ownerPage.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "Voice" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Create channel", exact: true })).toBeDisabled();
  await dialog.getByLabel("Channel name").fill("Game night");
  await dialog.getByRole("button", { name: "Create channel", exact: true }).click();
  await expect(ownerPage.getByRole("button", { name: "Open Game night", exact: true })).toBeVisible();
});
