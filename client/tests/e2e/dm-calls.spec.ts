import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";

const password = "synthetic call password 123";
const setupToken = "test-setup-token-at-least-32-characters";
const headers = (s: { token: string; device_key: string }) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });

const stage = (page: Page) => page.getByTestId("call-stage");
const toast = (page: Page) => page.getByTestId("incoming-call");
const callButton = (page: Page, name: string) => page.getByTestId("people").getByRole("button", { name: `Call ${name}`, exact: true });
const openGeneral = (page: Page) => page.getByRole("button", { name: "Open general", exact: true }).click();

test("a 1:1 call rings the other person, who answers, declines, or loses the ring when the caller cancels", async ({ browser, request }) => {
  test.setTimeout(150000);
  const owner = await (await request.post("/api/setup", { data: { username: "dc_owner", password, setup_token: setupToken, device_name: "call fixture" } })).json();
  const me = await (await request.get("/api/me", { headers: headers(owner) })).json();
  test.skip(me.capabilities.voice !== true, "SFU transport not configured in this backend binary");
  for (const username of ["dc_bob", "dc_carol"]) {
    const invitation = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
    expect((await request.post("/api/invites/accept", { data: { token: invitation.token, username, password, device_name: "call fixture" } })).ok()).toBeTruthy();
  }

  const pages: Record<string, Page> = {};
  for (const name of ["dc_owner", "dc_bob", "dc_carol"]) {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto("/");
    await signIn(page, name, password);
    pages[name] = page;
  }
  const { dc_owner: ownerPage, dc_bob: bob, dc_carol: carol } = pages;

  // Call from People: the caller is in the call and sees Ringing until the other person joins.
  await callButton(ownerPage, "dc_bob").click();
  await expect(stage(ownerPage)).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  // Ringing is said once, on the stage, with who is being rung; the controls are not doubled up by the sidebar dock.
  await expect(ownerPage.getByTestId("call-ringing")).toHaveText("Ringing dc_bob");
  await expect(ownerPage.getByText(/^Ringing/)).toHaveCount(1);
  await expect(ownerPage.getByTestId("call-dock")).toBeVisible(); // HC-040 6: the call card stays in the sidebar on the stage too
  await expect(toast(bob)).toBeVisible({ timeout: 15000 });
  await expect(toast(bob)).toContainText("dc_owner");
  await expect(toast(bob)).toContainText("Incoming call");
  // Nobody else hears it.
  await expect(toast(carol)).toHaveCount(0);

  await bob.getByRole("button", { name: "Answer dc_owner", exact: true }).click();
  await expect(toast(bob)).toHaveCount(0);
  for (const page of [ownerPage, bob]) {
    await expect(stage(page)).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    await expect(page.getByTestId("call-tile")).toHaveCount(2, { timeout: 30000 });
  }
  await expect(ownerPage.getByTestId("call-ringing")).toHaveCount(0);
  await bob.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
  await ownerPage.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
  await expect(stage(ownerPage)).toHaveCount(0);
  await expect(stage(bob)).toHaveCount(0);

  // Decline: the caller sees Declined and then leaves by itself.
  await openGeneral(ownerPage);
  await callButton(ownerPage, "dc_carol").click();
  await expect(toast(carol)).toBeVisible({ timeout: 15000 });
  await carol.getByRole("button", { name: "Decline dc_owner", exact: true }).click();
  await expect(toast(carol)).toHaveCount(0);
  await expect(ownerPage.getByTestId("call-ringing")).toHaveText("Declined", { timeout: 15000 });
  await expect(stage(ownerPage)).toHaveCount(0, { timeout: 15000 });

  // Cancel: the caller hangs up before an answer and the ring goes away on the other side.
  await openGeneral(carol);
  await callButton(carol, "dc_bob").click();
  await expect(stage(carol)).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await expect(toast(bob)).toBeVisible({ timeout: 15000 });
  await carol.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
  await expect(toast(bob)).toHaveCount(0, { timeout: 15000 });
  await expect(stage(carol)).toHaveCount(0);

  // Calling someone you already have a direct conversation with reuses it (no second one is made).
  // The owner and Bob's conversation was last rung well over the 10 s limit ago, but wait to be sure.
  const dmCount = async () => (await (await request.get("/api/channels", { headers: headers(owner) })).json()).channels.filter((channel: { kind: string }) => channel.kind === "dm").length;
  const dms = await dmCount();
  expect(dms).toBe(2); // owner with Bob, owner with Carol; Carol and Bob's is not the owner's to see
  await bob.waitForTimeout(10500);
  await openGeneral(bob);
  await callButton(bob, "dc_owner").click();
  await expect(toast(ownerPage)).toContainText("dc_bob", { timeout: 15000 });
  expect(await dmCount()).toBe(dms);
  await bob.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
  await expect(toast(ownerPage)).toHaveCount(0, { timeout: 15000 });

  // Nobody has posted in the owner's conversation with Bob, yet its header still has the Call button.
  await ownerPage.getByRole("button", { name: "Direct messages", exact: true }).click();
  await ownerPage.getByRole("button", { name: "Open dc_bob", exact: true }).click();
  const headerCall = ownerPage.locator("header.hc-header").getByRole("button", { name: "Call dc_bob", exact: true });
  await expect(headerCall).toBeVisible();
  await expect(ownerPage.getByTestId("people").getByRole("button", { name: "Call dc_bob", exact: true })).toBeVisible();
  await bob.waitForTimeout(10500);
  await headerCall.click();
  await expect(toast(bob)).toContainText("dc_owner", { timeout: 15000 });
  await ownerPage.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
  await expect(toast(bob)).toHaveCount(0, { timeout: 15000 });
});
