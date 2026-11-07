import { test, expect, type Page } from "@playwright/test";
const password = "correct horse battery staple";
async function accept(page: Page, link: string, name: string) {
  await page.goto(link);
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password (at least 12 characters)").fill(password);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}
async function send(page: Page, body: string) {
  await page
    .getByTestId("screen-composer")
    .getByLabel("Message", { exact: true })
    .fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByTestId("screen-conversation").getByText(body, { exact: false }),
  ).toBeVisible();
}
async function invite(page: Page) {
  await page
    .getByRole("button", { name: "Issue invitation", exact: true })
    .click();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/invites") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  const issued = await (await response).json();
  await expect(
    page.getByTestId("screen-invites-admin").locator("li"),
  ).toContainText(issued.token);
  const link = await page
    .getByTestId("screen-invites-admin")
    .locator("li")
    .innerText();
  await page.getByRole("button", { name: "Back to conversation" }).click();
  return link;
}
test("three private users: invitation, realtime mentions, unsend/retraction, edits, replies, pins, DM isolation and revocation", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  for (const context of contexts)
    await context.addInitScript(() => {
      const ledger: { shown: string[]; closed: string[] } = {
        shown: [],
        closed: [],
      };
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
  const [owner, bob, carol] = await Promise.all(
    contexts.map((c) => c.newPage()),
  );
  for (const [index, page] of [owner, bob, carol].entries()) {
    page.setDefaultTimeout(15000);
    page.on("response", response => {
      if (response.status() >= 400)
        console.log(`Fixture user ${index}: HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
  }
  const authenticator = await contexts[1].newCDPSession(bob);
  await authenticator.send("WebAuthn.enable");
  await authenticator.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await owner.goto("/");
  await owner.getByRole("button", { name: "First-run setup" }).click();
  await owner
    .getByLabel("Setup token")
    .fill(
      process.env.CHRISCORD_SETUP_TOKEN ??
        "test-setup-token-at-least-32-characters",
    );
  await owner.getByLabel("Username", { exact: true }).fill("owner");
  await owner.getByLabel("Password (at least 12 characters)").fill(password);
  await owner.getByRole("button", { name: "Initialize", exact: true }).click();
  await expect(owner.getByTestId("screen-composer")).toBeVisible();
  const bobInvite = await invite(owner);
  await accept(bob, bobInvite, "bob");
  await accept(carol, await invite(owner), "carol");
  await send(owner, "Hello @bob and @carol");
  await expect(bob.getByTestId("screen-conversation")).toContainText(
    "Hello @bob and @carol",
  );
  await expect(carol.getByTestId("screen-conversation")).toContainText(
    "Hello @bob and @carol",
  );
  const row = owner
    .getByTestId("screen-conversation")
    .locator("li")
    .filter({ hasText: "Hello @bob and @carol" });
  const messageId = await row.getAttribute("data-item-id");
  await expect
    .poll(() =>
      bob.evaluate(
        () =>
          (window as unknown as { notificationEvidence: { shown: string[] } })
            .notificationEvidence.shown,
      ),
    )
    .toContain(messageId);
  await row.getByRole("button", { name: "Unsend", exact: true }).click();
  for (const page of [owner, bob, carol])
    await expect(page.getByTestId("screen-conversation")).not.toContainText(
      "Hello @bob and @carol",
    );
  await expect
    .poll(() =>
      bob.evaluate(
        () =>
          (window as unknown as { notificationEvidence: { closed: string[] } })
            .notificationEvidence.closed,
      ),
    )
    .toContain(messageId);
  await bob.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(
    bob.getByTestId("screen-notifications").locator("li"),
  ).toHaveCount(0);
  await bob.getByRole("button", { name: "Back to conversation" }).click();
  await send(bob, "Editable message");
  let bobRow = bob
    .getByTestId("screen-conversation")
    .locator("li")
    .filter({ hasText: "Editable message" });
  await bobRow.getByRole("button", { name: "Edit", exact: true }).click();
  await bob
    .getByTestId("screen-composer")
    .getByLabel("Message", { exact: true })
    .fill("Edited message");
  await bob.getByRole("button", { name: "Save edit" }).click();
  await expect(carol.getByTestId("screen-conversation")).toContainText(
    "Edited message",
  );
  await carol
    .getByTestId("screen-conversation")
    .locator("li")
    .filter({ hasText: "Edited message" })
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await send(carol, "Thread reply");
  await expect(owner.getByTestId("screen-conversation")).toContainText(
    "Thread reply (reply)",
  );
  await owner
    .getByTestId("screen-conversation")
    .locator("li")
    .filter({ hasText: "Edited message" })
    .getByRole("button", { name: "Pin", exact: true })
    .click();
  await expect(bob.getByTestId("screen-conversation")).toContainText(
    "Edited message (pinned)",
  );
  await owner.getByRole("button", { name: "Search", exact: true }).click();
  await owner.getByLabel("Search query").fill("Edited");
  await owner
    .getByTestId("screen-search")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(owner.getByTestId("screen-search")).toContainText(
    "Edited message",
  );
  await owner.getByRole("button", { name: "Back to conversation" }).click();
  // Control-state synchronization is separate from unavailable provider playback.
  for(const page of [owner,bob,carol])await page.getByRole('button',{name:'Activity controls',exact:true}).click();
  await owner.getByRole('button',{name:'Start plex control session'}).click();
  await owner.getByLabel('Plex item ID').fill('123');
  await owner.getByRole('button',{name:'Apply control command'}).click();
  await owner.getByTestId('screen-activities').getByRole('button',{name:'Play',exact:true}).click();
  for(const page of [bob,carol])await expect(page.getByTestId('screen-activities').locator('[data-item-id="snapshot"]')).toContainText('playing');
  await owner.getByTestId('screen-activities').getByRole('button',{name:'Pause',exact:true}).click();
  await owner.getByLabel('Control command (select, enqueue, seek, handoff)').fill('seek');
  await owner.getByLabel('Seek position in milliseconds').fill('42000');
  await owner.getByRole('button',{name:'Apply control command'}).click();
  for(const page of [bob,carol])await expect(page.getByTestId('screen-activities')).toContainText('position 42000');
  await owner.getByRole('button',{name:'Stop activity',exact:true}).click();
  await owner.getByRole('button',{name:'Start dj control session'}).click();
  await owner.getByLabel('Control command (select, enqueue, seek, handoff)').fill('enqueue');
  await owner.getByLabel('Track title').fill('Queue fixture');await owner.getByLabel('Track link').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await owner.getByRole('button',{name:'Apply control command'}).click();
  for(const page of [bob,carol])await expect(page.getByTestId('screen-activities')).toContainText('Queue fixture');
  await owner.getByRole('button',{name:'Stop activity',exact:true}).click();await owner.getByRole('button',{name:'Start vm control session'}).click();
  await bob.getByRole('button',{name:'Request VM control'}).click();
  for(const page of [owner,carol])await expect(page.getByTestId('screen-activities')).toContainText('controller bob');
  await owner.getByRole('button',{name:'Stop activity',exact:true}).click();
  for(const page of [owner,bob,carol])await page.getByRole('button',{name:'Back to conversation'}).click();
  await owner.getByRole('button',{name:'Gimme request (dry run)',exact:true}).click();await owner.getByLabel('Movie or show').fill('Arrival 2016');await owner.getByRole('button',{name:'Preview request'}).click();await expect(owner.getByTestId('screen-gimme')).toContainText('Preview saved — no provider request sent');await owner.getByRole('button',{name:'Back to conversation'}).click();
  for (const page of [owner, bob, carol]) await expect(page.getByTestId('screen-conversation')).toContainText('Arrival 2016: Preview saved — no provider request sent');
  await owner.getByRole('button',{name:'Upload file',exact:true}).click();await owner.getByLabel('File',{exact:true}).setInputFiles({name:'upload-fixture.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(5*1024*1024,23)});await owner.getByRole('button',{name:'Upload',exact:true}).click();await expect(owner.getByTestId('screen-uploads')).toContainText('5242880/5242880 bytes (quarantined)',{timeout:30000});await expect(owner.getByRole('button',{name:'Attach to message'})).toBeDisabled();await owner.getByRole('button',{name:'Back to conversation'}).click();
  await owner.getByRole("button", { name: "New DM" }).click();
  const memberText = await owner
    .getByTestId("screen-direct-messages")
    .locator("li")
    .filter({ hasText: "bob:" })
    .innerText();
  const bobId = memberText.split(": ")[1];
  await owner.getByLabel("Conversation name").fill("Private chat");
  await owner.getByLabel("Member IDs (comma-separated)").fill(bobId);
  await owner
    .getByTestId("screen-direct-messages")
    .getByRole("button", { name: "Submit", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Open Private chat", exact: true })
    .click();
  await send(owner, "Private only");
  await expect(
    bob.getByRole("button", { name: "Open Private chat", exact: true }),
  ).toBeVisible();
  await expect(
    carol.getByRole("button", { name: "Open Private chat", exact: true }),
  ).toHaveCount(0);
  await bob.getByRole("button", { name: "Devices", exact: true }).click();
  const registered = bob.waitForResponse((r) =>
    r.url().endsWith("/api/passkeys/register/finish"),
  );
  await bob.getByRole("button", { name: "Add passkey", exact: true }).click();
  const registrationResponse=await registered;
  expect(registrationResponse.status()).toBe(200);
  await bob.screenshot({path:'../evidence/client-devices.png'});
  const oldHeaders={Authorization:(await registrationResponse.request().headerValue('authorization'))!,'X-Device-Key':(await registrationResponse.request().headerValue('x-device-key'))!};
  const registrationReplay=await contexts[1].request.post(registrationResponse.url(),{headers:oldHeaders,data:registrationResponse.request().postDataJSON()});
  expect(registrationReplay.status()).toBeGreaterThanOrEqual(400);
  await bob
    .getByTestId("screen-devices")
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(bob.getByTestId("screen-login")).toBeVisible();
  expect((await contexts[1].request.get('http://localhost:1420/api/me',{headers:oldHeaders})).status()).toBe(401);
  await bob.getByLabel("Username", { exact: true }).fill("bob");
  const asserted=bob.waitForResponse(r=>r.url().endsWith('/api/passkeys/login/finish'));
  await bob
    .getByRole("button", { name: "Sign in with passkey", exact: true })
    .click();
  await expect(bob.getByTestId("screen-composer")).toBeVisible();
  const assertionResponse=await asserted;
  expect(assertionResponse.status()).toBe(200);
  expect((await contexts[1].request.post(assertionResponse.url(),{data:assertionResponse.request().postDataJSON()})).status()).toBeGreaterThanOrEqual(400);
  await owner.screenshot({ path: "../evidence/client-chat.png" });
  for (const context of contexts) await context.close();
});
