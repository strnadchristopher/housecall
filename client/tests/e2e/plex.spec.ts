import { test, expect, type BrowserContext } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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
      await page.getByLabel("Username", { exact: true }).fill(username);
      await page.getByLabel("Password (at least 12 characters)").fill(password);
      await page
        .getByTestId("screen-login")
        .getByRole("button", { name: "Sign in", exact: true })
        .first()
        .click();
      await expect(page.getByTestId("screen-composer")).toBeVisible({
        timeout: 30000,
      });
    }
    for (const context of contexts) {
      const page = context.pages()[0];
      await page
        .getByRole("button", { name: "Voice and video", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Join with microphone and camera" })
        .click();
      await expect(page.getByTestId("screen-voice")).toContainText("live", {
        timeout: 30000,
      });
    }
    const host = contexts[0].pages()[0];
    await host.getByRole("button", { name: "Activity controls", exact: true }).click();
    await host
      .getByRole("button", { name: "Start plex control session", exact: true })
      .click();
    await expect(
      host.getByRole("button", { name: "Browse Plex library", exact: true }),
    ).toBeEnabled();
    await host
      .getByRole("button", { name: "Browse Plex library", exact: true })
      .click();
    await host
      .getByRole("button", { name: "Browse library", exact: true })
      .click();
    await expect(host.getByTestId("screen-plex")).toContainText(
      "Synthetic Plex fixture",
    );
    await host
      .getByRole("button", { name: "Watch together", exact: true })
      .click();
    for (const context of contexts)
      await expect(context.pages()[0].getByTestId("plex-media")).toBeAttached({
        timeout: 30000,
      });
    await host
      .getByTestId("screen-activities")
      .getByRole("button", { name: "Play", exact: true })
      .click();
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
    await host
      .getByTestId("screen-activities")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
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
    await host
      .getByLabel("Control command (select, enqueue, seek, handoff)")
      .fill("seek");
    await host.getByLabel("Seek position in milliseconds").fill("6000");
    await host
      .getByRole("button", { name: "Apply control command", exact: true })
      .click();
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
