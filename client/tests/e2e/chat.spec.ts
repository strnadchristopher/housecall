import { test, expect } from "@playwright/test";
import { accept, act, invite, password, row, send, setup, signIn } from "./helpers";

test("three private users: invitation, realtime mentions, unsend/retraction, edits, replies, pins, DM isolation and revocation", async ({
  browser,
}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  for (const context of contexts)
    await context.addInitScript(() => {
      const ledger: { shown: string[]; closed: string[] } = { shown: [], closed: [] };
      Object.assign(window, { notificationEvidence: ledger });
      class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        tag: string;
        constructor(_title: string, options: NotificationOptions) {
          this.tag = options.tag ?? "";
          ledger.shown.push(this.tag);
        }
        close() {
          ledger.closed.push(this.tag);
        }
      }
      Object.assign(window, { Notification: FakeNotification });
    });
  const [owner, bob, carol] = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of [owner, bob, carol].entries()) {
    page.setDefaultTimeout(15000);
    page.on("response", response => {
      if (response.status() >= 400) console.log(`Fixture user ${index}: HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
  }
  await setup(owner, "owner");
  // This fixture has no voice transport, so no call control is rendered.
  await expect(owner.getByTestId("call-bar")).toHaveCount(0);
  await accept(bob, await invite(owner), "bob");
  await accept(carol, await invite(owner), "carol");

  await send(owner, "Hello @bob and @carol");
  for (const page of [bob, carol]) await expect(page.getByTestId("screen-conversation")).toContainText("Hello @bob and @carol");
  const messageId = await row(owner, "Hello @bob and @carol").getAttribute("data-message-id");
  const ledger = (key: "shown" | "closed") => () =>
    bob.evaluate(name => (window as unknown as { notificationEvidence: Record<string, string[]> }).notificationEvidence[name], key);
  await expect.poll(ledger("shown")).toContain(messageId);
  await act(owner, "Hello @bob and @carol", "Unsend");
  await owner.getByRole("button", { name: "Unsend for everyone", exact: true }).click();
  for (const page of [owner, bob, carol]) await expect(page.getByTestId("screen-conversation")).not.toContainText("Hello @bob and @carol");
  await expect.poll(ledger("closed")).toContain(messageId);
  await bob.getByRole("button", { name: "Settings", exact: true }).click();
  await bob.getByTestId("screen-settings").getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(bob.getByTestId("screen-notifications").locator("ul li")).toHaveCount(0);
  await bob.getByTestId("screen-settings").getByRole("button", { name: "Close", exact: true }).click();

  await send(bob, "Editable message");
  await act(bob, "Editable message", "Edit");
  await bob.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill("Edited message");
  await bob.getByRole("button", { name: "Save edit" }).click();
  await expect(row(carol, "Edited message")).toContainText("edited");
  await act(carol, "Edited message", "Reply");
  await send(carol, "Thread reply");
  await expect(row(owner, "Thread reply").locator(".hc-msg__reply")).toContainText("Edited message");
  await act(owner, "Edited message", "Pin");
  await expect(row(bob, "Edited message")).toContainText("Pinned");
  await act(owner, "Edited message", "React");
  await row(owner, "Edited message").getByRole("option", { name: "🎉" }).click();
  await expect(row(carol, "Edited message").getByRole("button", { name: "🎉 1" })).toBeVisible();

  await owner.getByRole("button", { name: "Search", exact: true }).click();
  await owner.getByLabel("Search messages").fill("Edited");
  await owner.getByLabel("Search messages").press("Enter");
  await expect(owner.getByTestId("screen-search")).toContainText("Edited message");
  await owner.getByRole("button", { name: "Pins", exact: true }).click();
  await expect(owner.getByTestId("screen-pins")).toContainText("Edited message");
  await owner.getByRole("complementary").getByRole("button", { name: "Back", exact: true }).click();

  // Nothing is configured in this fixture, so the Chords tab is empty.
  for (const page of [owner, bob, carol]) {
    await page.getByRole("tab", { name: "Chords" }).click();
    await expect(page.getByTestId("chords").locator("button")).toHaveCount(0);
    await page.getByRole("tab", { name: "People" }).click();
    await expect(page.getByTestId("people").locator("li")).toHaveCount(3);
  }

  if (process.env.HOUSECALL_TEST_UPLOADS === "1") {
    await owner.locator('input[type="file"]').setInputFiles({ name: "upload-fixture.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024, 23) });
    await expect(owner.getByTestId("upload")).toHaveAttribute("data-state", "held", { timeout: 30000 });
    await expect(owner.getByTestId("attached")).toHaveCount(0);
  }

  await owner.getByRole("button", { name: "Direct messages", exact: true }).click();
  const direct = owner.getByTestId("screen-direct-messages");
  await direct.getByRole("checkbox", { name: "Add bob" }).click();
  await direct.getByLabel("Name (optional)").fill("Private chat");
  await direct.getByRole("button", { name: "Start", exact: true }).click();
  await expect(owner.getByRole("heading", { name: "Private chat" })).toBeVisible();
  await send(owner, "Private only");
  await bob.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(bob.getByRole("button", { name: "Open Private chat", exact: true })).toBeVisible();
  await carol.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(carol.getByTestId("screen-direct-messages")).toBeVisible();
  await expect(carol.getByRole("button", { name: "Open Private chat", exact: true })).toHaveCount(0);

  await bob.getByRole("button", { name: "Settings", exact: true }).click();
  await bob.getByTestId("screen-settings").getByRole("button", { name: "Devices", exact: true }).click();
  const revoked = bob.waitForRequest(request => request.url().includes("/api/devices/") && request.method() === "DELETE");
  await bob.getByTestId("screen-devices").getByRole("button", { name: "Revoke" }).click();
  const request = await revoked;
  const oldHeaders = { Authorization: (await request.headerValue("authorization"))!, "X-Device-Key": (await request.headerValue("x-device-key"))! };
  await expect(bob.getByTestId("screen-sign-in")).toBeVisible();
  expect((await contexts[1].request.get("http://localhost:1420/api/me", { headers: oldHeaders })).status()).toBe(401);
  expect(password.length).toBeGreaterThanOrEqual(12);
  await signIn(bob, "bob");
  await owner.screenshot({ path: `test-results/${process.env.HOUSECALL_ARTIFACT_PREFIX ?? ""}client-chat.png` });
  for (const context of contexts) await context.close();
});
