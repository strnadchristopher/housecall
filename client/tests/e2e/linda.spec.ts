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
    notes.push("Next day she has to sign in again with username and password (session is memory-only on web).");
    await linda.getByLabel("Username", { exact: true }).fill("linda");
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
  notes.push(`Chat header top edge at y=${headerBox?.y ?? "?"}; .hc-root padding-top ${await linda.locator(".hc-root").evaluate(el => getComputedStyle(el).paddingTop)} (the root pads by env(safe-area-inset-*), so on an iPhone the page background shows as a band under the status bar).`);
  const settingsButton = linda.getByRole("button", { name: /^(Server settings|Settings)$/ }).first();
  await tap(settingsButton);
  await linda.waitForTimeout(400);
  await shot("7-settings");
  const settings = linda.getByTestId("screen-settings");
  const sections = await settings.locator(".hc-settings__nav button").allInnerTexts();
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
  const inviteRow = settings.getByRole("button", { name: /Invite/ });
  if (await inviteRow.count()) {
    await tap(inviteRow.first());
    await shot("9-invite");
  } else {
    notes.push("A member has no way to invite anyone: Invites is owner-only and nothing says to ask the owner.");
    await shot("9-no-invite");
  }

  // 6. Leave settings the way she came in.
  task = "leave settings";
  const out1 = settings.getByRole("button", { name: /^(Back|Close|Settings)$/ }).first();
  const label = await out1.getAttribute("aria-label");
  await tap(out1);
  await linda.waitForTimeout(400);
  await shot("10-after-settings");
  notes.push(`Leaving settings (${label}) lands on: ${await visible(linda.getByTestId("screen-composer")) ? "the chat" : "the list"}.`);

  const rows = Object.entries(taps).map(([name, count]) => `| ${name} | ${count} | ${count > 5 ? "RED" : "ok"} |`);
  await writeFile(`${out}/result.md`, [
    "| Task | Taps | Verdict |", "|---|---|---|", ...rows, "",
    ...notes.map(note => `- ${note}`), "",
    errors.length ? `Console errors:\n${errors.map(error => `- ${error}`).join("\n")}` : "Console errors: none", "",
  ].join("\n"));
  await context.close();
  await ownerCtx.close();
});
