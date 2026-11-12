import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { password, setupToken, signIn } from "./helpers";

// README screenshots. Seeds invented people and messages through the API, then captures the
// app at 2x. Rewrites docs/readme/*.png, so it has its own flag:
// HOUSECALL_TEST_README=1 npx playwright test
const out = "../docs/readme";

type Session = { token: string; device_key: string; user: { id: string } };
const auth = (s: Session) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });

async function post<T>(request: APIRequestContext, path: string, data: unknown, s?: Session): Promise<T> {
  const res = await request.post(path, { data, headers: s ? auth(s) : {} });
  expect(res.ok(), `${path} ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function open(browser: Browser, width: number, height: number, scheme: "dark" | "light") {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: width < 600, isMobile: width < 600, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto("/");
  return { context, page };
}

test("readme screenshots", async ({ browser, request }) => {
  test.setTimeout(240000);
  const owner = await post<Session>(request, "/api/setup", { setup_token: setupToken, username: "theo", password, device_name: "fixture" });
  const people: Record<string, Session> = { theo: owner };
  for (const name of ["mara", "june", "felix"]) {
    const inv = await post<{ link: string }>(request, "/api/invites", { expires_in_seconds: 3600 }, owner);
    const token = inv.link.split("#invite=")[1];
    people[name] = await post<Session>(request, "/api/invites/accept", { token, username: name, password, device_name: "fixture" });
  }
  const { channels } = await (await request.get("/api/channels", { headers: auth(owner) })).json();
  const general = channels.find((c: { name: string }) => c.name === "general").id;
  const ids = Object.values(people).map(p => p.user.id);
  const make = async (name: string) => (await post<{ id: string }>(request, "/api/channels", { name, kind: "channel", member_ids: ids }, owner)).id;
  const movie = await make("movie-night");
  const kitchen = await make("kitchen");
  await make("photos");

  const say = async (who: string, channel: string, body: string, reply_to: string | null = null) =>
    (await post<{ id: string }>(request, `/api/channels/${channel}/messages`, { body, reply_to, mention_ids: [] }, people[who])).id;
  const react = (who: string, id: string, emoji: string) => post(request, `/api/messages/${id}/reactions`, { emoji }, people[who]);

  await say("june", kitchen, "Sourdough attempt #4 is out of the oven 🍞");
  await say("felix", kitchen, "Save me the heel.");
  await say("mara", movie, "Shortlist: *Paddington 2*, *Arrival*, or *The Grand Budapest Hotel*");
  await say("felix", movie, "Arrival. Bring tissues.");

  const a = await say("theo", general, "Welcome in, everyone. The kettle is on ☕️");
  await react("mara", a, "❤️");
  await react("june", a, "❤️");
  await say("june", general, "Okay this is so much nicer than the old group text");
  const photos = await say("felix", general, "Can we finally stop losing photos in a 400-message thread");
  await say("theo", general, "That's what #photos is for. Full quality, no compression.", photos);
  await react("felix", photos, "🙏");
  await say("mara", general, "Who set this up? It's fast.");
  await say("theo", general, "Runs on the little box under my desk 🙂");
  await say("june", general, "The real cloud was the friends we made along the way");
  await say("mara", general, "Is the film still on for Friday?");
  const plan = await say("theo", general, "Yes — **8 pm**, my place. Bring the good blanket.");
  await react("june", plan, "🎬");
  await react("felix", plan, "🎬");
  await react("mara", plan, "🙌");
  await post(request, `/api/messages/${plan}/pin`, { pinned: true }, people.mara);
  await say("june", general, "I'll bring popcorn. Salted or the fancy caramel one?");
  const both = await say("felix", general, "Both. Obviously.", null);
  await react("theo", both, "😂");
  await react("june", both, "😂");
  await say("mara", general, "Hopping on a call in a sec if anyone wants to pick the movie live 📞");

  const shoot = async (width: number, height: number, scheme: "dark" | "light", name: string, phone: "list" | "chat" | null = null) => {
    const { context, page } = await open(browser, width, height, scheme);
    if (phone) {
      await page.getByLabel("Username", { exact: true }).fill("theo");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByTestId("screen-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Open / }).first()).toBeVisible();
      if (phone === "chat") await page.getByRole("button", { name: /^Open general/ }).first().click();
    } else await signIn(page, "theo");
    if (phone !== "list") {
      const conv = page.getByTestId("screen-conversation");
      if (!(await conv.textContent())?.includes("Hopping on a call")) await page.getByRole("button", { name: /general/ }).first().click();
      await expect(conv).toContainText("Hopping on a call");
    }
    await page.waitForTimeout(800);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
    await context.close();
  };

  await shoot(1280, 800, "dark", "desktop-dark");
  await shoot(1280, 800, "light", "desktop-light");
  await shoot(390, 844, "dark", "phone-chat-dark", "chat");
  await shoot(390, 844, "light", "phone-chat-light", "chat");
  {
    const { context, page } = await open(browser, 390, 844, "dark");
    await expect(page.getByTestId("screen-sign-in")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/phone-sign-in-dark.png`, animations: "disabled" });
    await context.close();
  }
});
