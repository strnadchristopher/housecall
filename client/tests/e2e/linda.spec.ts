import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { password, setup } from "./helpers";

/**
 * Adversarial UX walk-through (skill: adversarial-ux-test). Persona: Linda, 61, iPhone, texts and Facebook only.
 * She was texted an invite link and wants to say hi in the family chat. Synthetic accounts only.
 * Each task records taps, the screens she saw and what went wrong; nothing here fails on a UX problem,
 * only on the fixture itself. Run on purpose with HOUSECALL_TEST_LINDA=1 (writes docs/ux/$HOUSECALL_UX_OUT).
 */
const out = `../docs/ux/${process.env.HOUSECALL_UX_OUT ?? "mobile-baseline"}`;
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" as const };

test("linda: invite link, first post, next-day post, colour, invite her sister", async ({ browser }) => {
  test.setTimeout(240000);
  await mkdir(out, { recursive: true });
  const notes: string[] = [];
  const taps: Record<string, number> = {};
  const errors: string[] = [];
  let task = "";

  // The owner (a synthetic fixture account) sets up and makes Linda's invite on a laptop.
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const owner = await ownerCtx.newPage();
  await setup(owner, "owner");
  await owner.getByRole("button", { name: "Server settings", exact: true }).click();
  await owner.getByTestId("screen-invites").getByRole("button", { name: /^Create invite/ }).click();
  const link = await owner.getByTestId("invite-link").inputValue();

  const context = await browser.newContext(phone);
  const linda = await context.newPage();
  linda.on("console", message => { if (message.type() === "error") errors.push(`${task}: ${message.text()}`); });
  linda.on("pageerror", error => errors.push(`${task}: ${error.message}`));
  const shot = (name: string) => linda.screenshot({ path: `${out}/${name}.png` });
  const tap = async (target: Locator) => { taps[task] = (taps[task] ?? 0) + 1; await target.tap(); };
  const visible = (target: Locator) => target.isVisible().catch(() => false);
  /** Linda opens a conversation the way she would: whatever row says "general". */
  const openGeneral = async (page: Page) => {
    const header = page.locator(".hc-center .hc-header h1");
    if (await visible(header) && (await header.innerText()) === "general") return;
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await visible(menu)) await tap(menu);
    await tap(page.getByRole("button", { name: "Open general", exact: true }));
  };
  const post = async (page: Page, body: string) => {
    const box = page.getByTestId("screen-composer").getByLabel("Message", { exact: true });
    taps[task] = (taps[task] ?? 0) + 1;
    await box.tap();
    await box.fill(body);
    await tap(page.getByRole("button", { name: "Send", exact: true }));
    await expect(page.getByTestId("screen-conversation")).toContainText(body);
  };

  // 1. Open the invite link and make an account.
  task = "join from the invite link";
  await linda.goto(link);
  await shot("1-invite-link");
  const joinHeading = linda.getByTestId("screen-join").locator("h1");
  if (await visible(joinHeading)) notes.push(`Join screen title: "${await joinHeading.innerText()}".`);
  const nameField = linda.getByLabel(/^(Display name|Username)$/);
  notes.push(`Join screen asks for: ${(await linda.locator(".hc-onb label .hc-field__label, .hc-onb label > span").allInnerTexts()).join(" / ")}`);
  await nameField.fill("linda");
  await linda.getByLabel("Password, 12 or more characters").fill(password);
  await tap(linda.getByRole("button", { name: "Join", exact: true }));
  await expect(linda.getByTestId("screen-conversation")).toBeAttached();
  await linda.waitForTimeout(600);
  await shot("2-first-screen");
  const landedInChat = await visible(linda.getByTestId("screen-composer"));
  notes.push(landedInChat ? "After joining she lands in a chat." : "After joining she lands on a list (\"Conversations\"), not in a chat.");

  // 2. Find the family chat and say hi.
  task = "find the main chat and post";
  const row = linda.getByRole("button", { name: "Open general", exact: true });
  if (!landedInChat && await visible(row)) {
    const style = await row.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, h: el.getBoundingClientRect().height, color: s.color }; });
    notes.push(`"general" row: background ${style.bg}, height ${Math.round(style.h)} px, colour ${style.color}, chevron ${await row.locator(".hc-channel__chev").count() > 0 ? "yes" : "no"}.`);
  }
  await openGeneral(linda);
  await shot("3-general");
  await post(linda, "Hi everyone, it's Linda!");
  await shot("4-posted");

  // 3. Next day: the app was closed. Come back and post again.
  task = "come back next day and post";
  await linda.reload();
  await linda.waitForTimeout(800);
  await shot("5-next-day");
  const signIn = linda.getByTestId("screen-sign-in");
  if (await visible(signIn)) {
    const prefilled = await visible(signIn.getByTestId("sign-in-account"));
    notes.push(`Next day (web, memory-only session) she sees "${await signIn.locator("h1").innerText()}"; ${prefilled ? "her username is already there, only the password is asked" : "she has to type her username and password"}.`);
    if (!prefilled) await linda.getByLabel("Username", { exact: true }).fill("linda");
    await linda.getByLabel("Password", { exact: true }).fill(password);
    await tap(signIn.getByRole("button", { name: /^(Sign in|Log in)$/ }));
    await expect(linda.getByTestId("screen-conversation")).toBeAttached();
    await linda.waitForTimeout(600);
  }
  await shot("6-after-sign-in");
  notes.push(await visible(linda.getByTestId("screen-composer")) ? "After signing in she lands in a chat." : "After signing in she lands on the list again.");
  await openGeneral(linda);
  await post(linda, "Good morning!");

  // 4. Change the colour.
  task = "change the colour";
  const header = linda.locator(".hc-center .hc-header");
  const headerBox = await header.boundingBox();
  // Simulate an iPhone notch: does the header colour run behind the status bar, with its controls below it?
  await linda.addStyleTag({ content: ":root { --hc-safe-top: 47px; --hc-safe-bottom: 34px; }" });
  const rootPad = await linda.locator(".hc-root").evaluate(el => getComputedStyle(el).paddingTop);
  const headerPad = await header.evaluate(el => getComputedStyle(el).paddingTop);
  notes.push(`With a simulated 47 px notch: chat header top edge at y=${headerBox?.y ?? "?"}, root padding-top ${rootPad}, header padding-top ${headerPad}. ${headerPad === "4px" ? "Controls sit under the status bar (no inset), or the root pads and shows a band." : "Header colour reaches the top edge; its controls clear the status bar."}`);
  const settingsButton = linda.getByRole("button", { name: /^(Server settings|Settings)$/ }).first();
  await tap(settingsButton);
  await linda.waitForTimeout(400);
  await shot("7-settings");
  const settings = linda.getByTestId("screen-settings");
  const sections = await settings.locator(".hc-settings__nav button").evaluateAll(buttons => buttons.map(b => b.getAttribute("aria-label") ?? (b as HTMLElement).innerText));
  notes.push(`Settings shows these at once: ${sections.join(", ")}.`);
  const appearance = settings.getByRole("button", { name: /Appearance|Colou?r|Theme/ });
  if (await appearance.count()) {
    await tap(appearance.first());
    await shot("8-appearance");
  } else {
    notes.push("No colour, theme or appearance setting anywhere in Settings.");
  }
  await linda.screenshot({ path: `${out}/8-settings-full.png`, fullPage: true });

  // 5. Invite her sister.
  task = "invite her sister";
  // Back to the Settings root (she is on the Appearance page).
  const toRoot = settings.getByRole("button", { name: "Settings", exact: true });
  if (await visible(toRoot)) await tap(toRoot);
  const inviteRow = settings.getByRole("button", { name: /Invite/ });
  if (await inviteRow.count()) {
    await tap(inviteRow.first());
    await shot("9-invite");
    const page = settings.locator(".hc-settings__pane");
    notes.push(`Invite page says: "${(await page.innerText()).replace(/\s+/g, " ").trim()}".`);
  } else {
    notes.push("A member has no way to invite anyone: Invites is owner-only and nothing says to ask the owner.");
    await shot("9-no-invite");
  }

  // 6. Leave settings the way she came in.
  task = "leave settings";
  // Tap the top-left button until settings is gone (a tree takes one tap per level).
  const labels: string[] = [];
  for (let i = 0; i < 3 && await visible(settings); i++) {
    const out1 = settings.locator(".hc-header button").first();
    labels.push(await out1.getAttribute("aria-label") ?? "?");
    await tap(out1);
    await linda.waitForTimeout(400);
  }
  const label = labels.join(" then ");
  await shot("10-after-settings");
  notes.push(`Leaving settings (${label}) lands on: ${await visible(linda.getByTestId("screen-composer")) ? "the chat" : "the list"}.`);

  // 7. Her sister Rosa has no code: she downloads the app (here: opens the site) and asks to be let in.
  task = "sister asks to join without a code";
  const rosaCtx = await browser.newContext(phone);
  const rosa = await rosaCtx.newPage();
  rosa.on("pageerror", error => errors.push(`${task}: ${error.message}`));
  const rosaShot = (name: string) => rosa.screenshot({ path: `${out}/${name}.png` });
  const rtap = async (target: Locator) => { taps[task] = (taps[task] ?? 0) + 1; await target.tap(); };
  await rosa.goto("/");
  await rosaShot("11-rosa-welcome");
  notes.push(`First screen for someone with no link: ${(await rosa.locator(".hc-onb button, .hc-onb h1, .hc-onb p").allInnerTexts()).filter(Boolean).join(" / ")}.`);
  await rtap(rosa.getByRole("button", { name: "Sign up", exact: true }));
  await rosaShot("12-rosa-sign-up");
  await rosa.getByLabel(/Server address/).fill(new URL(rosa.url()).host);
  await rtap(rosa.getByRole("button", { name: "Continue" }));
  await rosaShot("13-rosa-server");
  await rtap(rosa.getByRole("button", { name: "Request access" }));
  await rosa.getByLabel("Username", { exact: true }).fill("rosa");
  await rosa.getByLabel("Password, 12 or more characters").fill(password);
  await rosa.getByLabel("Message to the owner").fill("It's Rosa, Linda's sister");
  await rtap(rosa.getByRole("button", { name: "Send request" }));
  await expect(rosa.getByTestId("screen-pending")).toBeVisible();
  await rosaShot("14-rosa-pending");
  notes.push(`After sending, Rosa sees: ${(await rosa.getByTestId("screen-pending").innerText()).replace(/\s+/g, " ").trim()}.`);
  // The owner approves on the laptop; Rosa comes back to the app later.
  task = "sister logs in once approved";
  const ownerSettings = owner.getByTestId("screen-settings");
  // Settings is still open on the laptop from making Linda's invite.
  if (!(await ownerSettings.isVisible())) await owner.getByRole("button", { name: "Server settings", exact: true }).click();
  await ownerSettings.getByRole("button", { name: "Access requests", exact: true }).click();
  await owner.getByRole("button", { name: "Approve rosa" }).click();
  // Coming back to the app re-checks on its own (simulated by a visibility change); no Refresh tap needed.
  await rosa.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(rosa.getByTestId("screen-pending")).toContainText("Approved");
  await rtap(rosa.getByRole("button", { name: "Log in", exact: true }));
  await rosa.getByLabel("Password", { exact: true }).fill(password);
  await rtap(rosa.getByTestId("screen-sign-in").getByRole("button", { name: "Log in", exact: true }));
  await expect(rosa.getByTestId("screen-conversation")).toBeAttached();
  await rosa.waitForTimeout(600);
  await rosaShot("15-rosa-in");
  notes.push(`After approval and logging in Rosa lands in: ${await rosa.locator(".hc-center .hc-header h1").innerText()}.`);
  await rosaCtx.close();

  const rows = Object.entries(taps).map(([name, count]) => `| ${name} | ${count} | ${count > 5 ? "RED" : "ok"} |`);
  await writeFile(`${out}/result.md`, [
    "| Task | Taps | Verdict |", "|---|---|---|", ...rows, "",
    ...notes.map(note => `- ${note}`), "",
    errors.length ? `Console errors:\n${errors.map(error => `- ${error}`).join("\n")}` : "Console errors: none", "",
  ].join("\n"));
  await context.close();
  await ownerCtx.close();
});
