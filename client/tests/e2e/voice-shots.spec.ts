import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { signIn } from "./helpers";

// Writes design/040/shots/after-voice-*.png. Run on purpose: node tests/run-suite.mjs HOUSECALL_TEST_VOICESHOTS
const out = join(process.cwd(), "../design/040/shots"); // cwd is client/
const password = "synthetic shots password 123";
const setupToken = "test-setup-token-at-least-32-characters";
const headers = (s: { token: string; device_key: string }) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });

let owner: { token: string; device_key: string };
let bobSession: { token: string; device_key: string };

test("voice shots", async ({ browser, request }) => {
  test.setTimeout(560000);
  for (const scheme of ["dark", "light"] as const) {
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    {

      if (!owner) {
        owner = await (await request.post("/api/setup", { data: { username: "vs_owner", password, setup_token: setupToken, device_name: "shots" } })).json();
        const invitation = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 900 } })).json();
        bobSession = await (await request.post("/api/invites/accept", { data: { token: invitation.token, username: "vs_bob", password, device_name: "shots" } })).json();
      }
      const lounge = (await (await request.get("/api/channels", { headers: headers(owner) })).json()).channels.find((c: { kind: string }) => c.kind === "voice").id;
      const shot = (page: Page, what: string) => page.screenshot({ path: join(out, `after-voice-${what}-${scheme}-${width}.png`) });
      const open = async (name: string, size: { width: number; height: number }): Promise<Page> => {
        const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: size, colorScheme: scheme });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        await page.goto("/");
        await signIn(page, name, password);
        return page;
      };
      // Bob is in the room, muted; the owner's own entry is LIVE.
      const bob = await open("vs_bob", { width: 1280, height: 800 });
      await bob.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true }).click();
      await expect(bob.getByTestId("call-stage")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
      await bob.getByTestId("call-bar").getByRole("button", { name: "Mute", exact: true }).click();
      const page = await open("vs_owner", { width, height });
      const phone = width < 700;
      if (phone) await page.getByRole("button", { name: "Menu", exact: true }).click();
      const row = page.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true });
      await expect(page.getByRole("list", { name: "In Lounge" })).toBeVisible({ timeout: 15000 });
      if (phone) {
        await shot(page, "drawer-occupied");
        await row.click();
        await expect(page.getByTestId("voice-sheet")).toBeVisible();
        await page.waitForTimeout(400);
        await shot(page, "voice-sheet");
        await page.getByTestId("voice-sheet").getByRole("button", { name: "Join voice", exact: true }).click();
      } else {
        await row.click();
      }
      await expect(page.getByTestId("call-stage")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
      await request.put(`/api/channels/${lounge}/voice/state`, { headers: headers(bobSession), data: { muted: true, deafened: false, camera: false, sharing: true } });
      if (phone) await page.waitForTimeout(5000);
      else await expect(page.getByRole("list", { name: "In Lounge" }).getByRole("button", { name: /vs_bob, live, muted/ })).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(600);
      if (phone) {
        await shot(page, "stage");
        await page.getByRole("button", { name: "Menu", exact: true }).click();
        await page.waitForTimeout(400);
        await shot(page, "drawer-callcard");
        await page.getByRole("button", { name: "vs_bob is live. Preview the stream" }).click();
        await expect(page.getByTestId("stream-preview")).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, "preview");
      } else {
        await shot(page, "stage-sidechat");
        await page.getByTestId("call-dock").screenshot({ path: join(out, `after-voice-callcard-${scheme}-${width}.png`) });
        await page.getByRole("button", { name: "vs_bob is live. Preview the stream" }).click();
        await expect(page.getByTestId("stream-preview")).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, "preview");
        await page.keyboard.press("Escape");
        await page.locator(".hc-left").screenshot({ path: join(out, `after-voice-sidebar-${scheme}-${width}.png`) });
      }
      // Leave properly so the next pass starts with two people, not the ghosts of this one.
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      await (phone ? page.getByTestId("call-dock") : page.getByTestId("call-bar")).getByRole("button", { name: "Leave", exact: true }).first().dispatchEvent("click");
      await bob.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).first().dispatchEvent("click");
      await page.waitForTimeout(1200);
      await page.context().close();
      await bob.context().close();
    }
  }
  }
});
