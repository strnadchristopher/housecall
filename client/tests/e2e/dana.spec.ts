import { test, expect, type Locator } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { accept, invite, password, setup } from "./helpers";

// Scripted run of the Dana tasks at 390x844 (PLAN Phase 2 UX step). Dana is a
// scripted client, not a person: this measures taps and what is on screen, it
// does not replace a session with a real first-time user.
// HOUSECALL_TEST_DANA=1 node tests/run-dana.mjs   (voice and the Plex fixture are on)
const out = "../docs/ux/phase-2";
const gif = { id: "fixture0001", title: "Fixture wave" };

test("dana: join from a link, find the live call, send a GIF, start Watch Now, message the friend", async ({ browser }) => {
  test.setTimeout(180000);
  await mkdir(out, { recursive: true });
  const owner = await (await browser.newContext({ permissions: ["camera", "microphone"] })).newPage();
  owner.setDefaultTimeout(20000);
  await setup(owner, "owner");
  // The friend is already in a call in the first channel.
  const ownerBar = owner.getByTestId("call-bar");
  await ownerBar.getByRole("button", { name: "Join", exact: true }).click();
  await expect(ownerBar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  const link = await invite(owner);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["camera", "microphone"] });
  const dana = await context.newPage();
  dana.setDefaultTimeout(20000);
  await dana.route("**/api/me", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, capabilities: { ...body.capabilities, giphy: true } } });
  });
  await dana.route("**/api/giphy/search*", route => route.fulfill({ json: { results: [gif] } }));
  await dana.route("**/api/giphy/media/*", route => route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(16) }));

  const taps: Record<string, number> = {};
  let task = "";
  const notes: string[] = [];
  const tap = async (target: Locator) => { taps[task] = (taps[task] ?? 0) + 1; await target.tap(); };
  const shot = (name: string) => dana.screenshot({ path: `${out}/${name}.png` });

  // 1. Join from the link. No server, key or port question may appear.
  task = "join from the invite link";
  await dana.goto(link);
  await expect(dana.getByTestId("screen-join")).toBeVisible();
  notes.push(`invite screen offers: ${(await dana.getByTestId("screen-join").getByRole("button").allInnerTexts()).join(" | ")}`);
  await shot("1-invite");
  await dana.getByLabel("Display name", { exact: true }).fill("dana");
  await dana.getByLabel("Password, 12 or more characters").fill(password);
  await tap(dana.getByRole("button", { name: "Join", exact: true }));
  await expect(dana.getByRole("navigation", { name: "Housecall" })).toBeVisible();

  // 2. Find the live call and join it. Start where a phone starts: the list.
  task = "find the live call and join it";
  const list = dana.getByRole("navigation", { name: "Housecall" });
  const inCallOnList = await list.getByTestId("channel-call").first().isVisible().catch(() => false);
  notes.push(`live call visible on the list before opening the channel: ${inCallOnList}`);
  await shot("2-list-with-live-call");
  await tap(list.getByRole("button", { name: /^Open / }).first());
  const bar = dana.getByTestId("call-bar");
  const people = await bar.innerText();
  notes.push(`call bar before joining reads: "${people.replace(/\s+/g, " ")}"`);
  await shot("2-conversation-before-join");
  await tap(bar.getByRole("button", { name: "Join", exact: true }));
  await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await shot("2-in-call");

  // 3. Send a GIF.
  task = "send a GIF";
  const composer = dana.getByTestId("screen-composer");
  await tap(composer.getByRole("button", { name: "GIF", exact: true }));
  await dana.getByPlaceholder(/search/i).fill("wave");
  await tap(dana.getByRole("button", { name: gif.title }));
  await expect(dana.getByTestId("screen-conversation").locator("video").first()).toBeVisible();

  // 4. Start Watch Now: the people sheet, Chords, Gimme, Start Watch, library, title.
  task = "start Watch Now";
  await tap(dana.getByRole("button", { name: "People", exact: true }));
  await shot("4-sheet");
  await tap(dana.getByRole("tab", { name: "Chords", exact: true }));
  await tap(dana.getByTestId("chords").getByRole("button", { name: /Gimme/ }));
  const gimme = dana.getByTestId("screen-gimme");
  await tap(gimme.getByRole("button", { name: "Start Watch", exact: true }));
  await tap(gimme.getByRole("button", { name: "Browse library", exact: true }));
  await tap(gimme.getByRole("button", { name: "Fixture Movies", exact: true }));
  await shot("4-library");
  await tap(gimme.getByRole("button", { name: "Watch Now", exact: true }));
  await expect(gimme.getByTestId("plex-media")).toBeAttached({ timeout: 30000 });
  await shot("4-watching");
  await tap(dana.getByRole("complementary").getByRole("button", { name: "Close", exact: true }));

  // 5. Message the friend.
  task = "message the friend";
  await tap(dana.getByRole("main").getByRole("button", { name: "Back", exact: true }));
  await tap(dana.getByRole("button", { name: "Direct messages", exact: true }));
  await shot("5-direct-messages");
  await tap(dana.getByTestId("screen-direct-messages").getByRole("checkbox", { name: "Add owner" }));
  await tap(dana.getByRole("button", { name: "Start", exact: true }));
  await composer.getByLabel("Message", { exact: true }).fill("Hi from Dana");
  await tap(dana.getByRole("button", { name: "Send", exact: true }));
  await expect(dana.getByTestId("screen-conversation")).toContainText("Hi from Dana");
  await shot("5-sent");

  const rows = Object.entries(taps).map(([name, count]) => `| ${name} | ${count} | ${count > 5 ? "RED" : "ok"} |`);
  await writeFile(`${out}/result.md`, ["| Task | Taps | Verdict |", "|---|---|---|", ...rows, "", ...notes.map(note => `- ${note}`), ""].join("\n"));
  await context.close();
});
