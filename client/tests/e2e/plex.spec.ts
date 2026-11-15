import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { signIn } from "./helpers";
const password = "correct horse battery staple";
test("three live voice peers browse and synchronously play real HLS from a synthetic Plex provider", async ({
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const contexts: BrowserContext[] = [];
  const owner = await (
    await request.post("/api/setup", {
      data: {
        setup_token: "test-setup-token-at-least-32-characters",
        username: "plex_owner",
        password,
        device_name: "Plex fixture",
      },
    })
  ).json();
  const headers = {
    Authorization: `Bearer ${owner.token}`,
    "X-Device-Key": owner.device_key,
  };
  expect(
    (await (await request.get("/api/me", { headers })).json()).capabilities
      .plex,
    "Plex fixture must actually be configured",
  ).toBe(true);
  try {
    for (const username of ["plex_alice", "plex_bob", "plex_carol"]) {
      const invitation = await (
        await request.post("/api/invites", {
          headers,
          data: { expires_in_seconds: 3600 },
        })
      ).json();
      expect(
        (
          await request.post("/api/invites/accept", {
            data: {
              token: invitation.token,
              username,
              password,
              device_name: "Plex fixture",
            },
          })
        ).ok(),
      ).toBeTruthy();
      const context = await browser.newContext({
        permissions: ["camera", "microphone"],
      });
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto("/");
      await signIn(page, username);
    }
    for (const context of contexts) {
      const page = context.pages()[0];
      const bar = page.getByTestId("call-bar");
      // Calls now start from voice channels; general is a text channel without a call bar.
      await page.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true }).click();
      await expect(bar).toHaveAttribute("data-phase", "live", {
        timeout: 30000,
      });
    }
    // Everyone opens the Gimme Chord (the film plays in its panel); the host starts Watch.
    for (const context of contexts) {
      const page = context.pages()[0];
      await page.getByRole("tab", { name: "Apps", exact: true }).click();
      await page.getByTestId("chords").getByRole("button", { name: /Gimme/ }).click();
    }
    const host = contexts[0].pages()[0];
    const gimme = host.getByTestId("screen-gimme");
    await gimme.getByRole("button", { name: "Start Watch", exact: true }).click();
    await gimme.getByRole("button", { name: "Browse library", exact: true }).click();
    await gimme.getByRole("button", { name: "Fixture Movies", exact: true }).click();
    await expect(gimme).toContainText("Synthetic Plex fixture");
    await gimme.getByRole("button", { name: "Watch Now", exact: true }).click();
    for (const context of contexts)
      await expect(context.pages()[0].getByTestId("plex-media")).toBeAttached({
        timeout: 30000,
      });
    await gimme.getByRole("button", { name: "Play", exact: true }).click();
    for (const context of contexts)
      await expect
        .poll(
          () =>
            context
              .pages()[0]
              .getByTestId("plex-media")
              .evaluate((element: HTMLVideoElement) => ({
                ready: element.readyState >= 2,
                playing: !element.paused,
                advanced: element.currentTime > 2,
              })),
          { timeout: 30000 },
        )
        .toEqual({ ready: true, playing: true, advanced: true });
    const playing=await Promise.all(contexts.map(context=>context.pages()[0].getByTestId('plex-media').evaluate((element:HTMLVideoElement)=>element.currentTime)));
    expect(Math.max(...playing)-Math.min(...playing)).toBeLessThan(0.5);
    await gimme.getByRole("button", { name: "Pause", exact: true }).click();
    for (const context of contexts)
      await expect
        .poll(() =>
          context
            .pages()[0]
            .getByTestId("plex-media")
            .evaluate((element: HTMLVideoElement) => element.paused),
        )
        .toBe(true);
    const paused = await Promise.all(
      contexts.map((context) =>
        context
          .pages()[0]
          .getByTestId("plex-media")
          .evaluate((element: HTMLVideoElement) => ({
            time: element.currentTime,
            width: element.videoWidth,
            height: element.videoHeight,
            frames: element.getVideoPlaybackQuality().totalVideoFrames,
          })),
      ),
    );
    expect(
      Math.max(...paused.map((peer) => peer.time)) -
        Math.min(...paused.map((peer) => peer.time)),
    ).toBeLessThan(0.5);
    await gimme.getByLabel("Position", { exact: true }).fill("6000");
    for (const context of contexts)
      await expect
        .poll(() =>
          context
            .pages()[0]
            .getByTestId("plex-media")
            .evaluate((element: HTMLVideoElement) =>
              Math.abs(element.currentTime - 6),
            ),
        )
        .toBeLessThan(0.5);
    await mkdir("../evidence", { recursive: true });
    await writeFile(
      "../evidence/client-plex-three-user.json",
      JSON.stringify(
        {
          note: "Real browser HLS decoding through authenticated Rust gateway using a synthetic local Plex-compatible provider. No live Plex account/library, provider transcode or subtitle support claimed.",
          playing,
          paused,
          seekSeconds: 6,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const context of contexts) await context.close();
  }
});
