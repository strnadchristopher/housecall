import { test, expect, type BrowserContext } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { fillSignIn, logInButton, openMenu } from "./helpers";
const password = "correct horse battery staple";

/** Joining is one click on the Lounge voice channel (a phone asks in a sheet first). */
async function joinLounge(page: import("@playwright/test").Page) {
  await page.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true }).click();
  const sheet = page.getByRole("button", { name: "Join voice", exact: true });
  if (await sheet.isVisible().catch(() => false)) await sheet.click();
}

async function loungeId(request: import("@playwright/test").APIRequestContext, headers: Record<string, string>): Promise<string> {
  const list = await (await request.get("/api/channels", { headers })).json();
  return list.channels.find((channel: { name: string; kind: string }) => channel.kind === "voice" && channel.name === "Lounge").id;
}
test("three browsers exchange real fake-device audio/video through the Rust SFU", async ({
  browser,
  request,
}) => {
  test.setTimeout(120000);
  let owner = await request.post("/api/setup", {
    data: {
      setup_token: "test-setup-token-at-least-32-characters",
      username: "owner",
      password,
      device_name: "voice fixture",
    },
  });
  if (owner.status() === 409)
    owner = await request.post("/api/login", {
      data: { username: "owner", password, device_name: "voice fixture" },
    });
  expect(owner.ok()).toBeTruthy();
  const session = await owner.json();
  const headers = {
    Authorization: `Bearer ${session.token}`,
    "X-Device-Key": session.device_key,
  };
  const me = await (await request.get("/api/me", { headers })).json();
  test.skip(
    me.capabilities.voice !== true,
    "SFU transport not configured in this backend binary",
  );
  const contexts: BrowserContext[] = [];
  let voiceHeaders: Record<string, string> | undefined;
  try {
    for (const username of ["voice_alice", "voice_bob", "voice_carol"]) {
      const invitation = await (
        await request.post("/api/invites", {
          headers,
          data: { email: "fixture@example.test", expires_in_seconds: 3600 },
        })
      ).json();
      expect(
        (
          await request.post("/api/invites/accept", {
            data: {
              token: invitation.token,
              username,
              password,
              device_name: "voice fixture",
            },
          })
        ).ok(),
      ).toBeTruthy();
      const context = await browser.newContext({
        permissions: ["camera", "microphone"],
      });
      contexts.push(context);
      await context.addInitScript(() => {
        const Base = window.RTCPeerConnection;
        const peers: RTCPeerConnection[] = [];
        const channels: RTCDataChannel[] = [];
        Object.assign(window, { testPeers: peers, testChannels: channels });
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            peers.push(this);
          }
          override createDataChannel(
            label: string,
            options?: RTCDataChannelInit,
          ) {
            const channel = super.createDataChannel(label, options);
            channels.push(channel);
            return channel;
          }
        };
      });
      const page = await context.newPage();
      await page.goto("/");
      await fillSignIn(page, username, password);
      const login = page.waitForResponse((response) =>
        response.url().endsWith("/api/login"),
      );
      await logInButton(page).click();
      const loginData = await (await login).json();
      voiceHeaders ??= {
        Authorization: `Bearer ${loginData.token}`,
        "X-Device-Key": loginData.device_key,
      };
      await expect(page.getByTestId("screen-composer")).toBeVisible({
        timeout: 30000,
      });
    }
    for (const context of contexts) {
      const page = context.pages()[0];
      const bar = page.getByTestId("call-bar");
      await joinLounge(page);
      await expect(bar).toHaveAttribute("data-phase", "live", {
        timeout: 30000,
      });
      await bar.getByRole("button", { name: "Camera on", exact: true }).click();
      await expect(
        bar.getByRole("button", { name: "Camera off", exact: true }),
      ).toBeVisible();
      if (context === contexts[0] && contexts.length > 1) {
        // Finding 2: someone who has not joined sees the running call, in the bar and in the list.
        const other = contexts[1].pages()[0];
        await expect(other.getByRole("list", { name: "In Lounge" })).toBeVisible({ timeout: 15000 });
      }
    }
    const evidence = [];
    for (const context of contexts) {
      const page = context.pages()[0];
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              let video = 0,
                audio = 0;
              for (const peer of (
                window as unknown as { testPeers: RTCPeerConnection[] }
              ).testPeers)
                for (const stat of (await peer.getStats()).values())
                  if (stat.type === "inbound-rtp") {
                    if (stat.kind === "video" && stat.framesDecoded > 0)
                      video++;
                    if (stat.kind === "audio" && stat.packetsReceived > 0)
                      audio++;
                  }
              return { video, audio };
            }),
          { timeout: 30000 },
        )
        .toEqual({ video: 2, audio: 2 });
      evidence.push(
        await page.evaluate(async () => {
          const inbound: Record<string, unknown>[] = [];
          for (const peer of (
            window as unknown as { testPeers: RTCPeerConnection[] }
          ).testPeers)
            for (const stat of (await peer.getStats()).values())
              if (stat.type === "inbound-rtp")
                inbound.push({
                  kind: stat.kind,
                  packetsReceived: stat.packetsReceived,
                  bytesReceived: stat.bytesReceived,
                  framesDecoded: stat.framesDecoded,
                  jitter: stat.jitter,
                });
          return {
            inbound,
            audioConfiguration:(window as unknown as {testPeers:RTCPeerConnection[]}).testPeers.flatMap(peer=>peer.getSenders().filter(sender=>sender.track?.kind==='audio').map(sender=>({encodings:sender.getParameters().encodings,settings:sender.track?.getSettings()}))),
            remoteMediaElements: document.querySelectorAll(
              '[data-testid="remote-media"]',
            ).length,
          };
        }),
      );
    }
    for (const peer of evidence) {
      expect(
        peer.inbound.filter(
          (s) => s.kind === "video" && Number(s.framesDecoded) > 0,
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        peer.inbound.filter(
          (s) => s.kind === "audio" && Number(s.packetsReceived) > 0,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    }
    await writeFile(
      "test-results/client-voice-three-user.json",
      JSON.stringify(
        {
          note: "Actual RTP from Chromium fake capture devices. Does not measure physical glass-to-glass latency.",
          peers: evidence,
        },
        null,
        2,
      ),
    );
    const publisher = contexts[0].pages()[0];
    await publisher.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d")!;
        const paint = () => {
          context.fillStyle = "#ff00ff";
          context.fillRect(0, 0, 320, 180);
          const now = Date.now() >>> 0;
          for (let bit = 0; bit < 32; bit++) {
            context.fillStyle = (now >>> (31 - bit)) & 1 ? "white" : "black";
            context.fillRect(bit * 10, 0, 10, 80);
          }
        };
        paint();
        const timer = setInterval(paint, 1000 / 30),
          stream = canvas.captureStream(30);
        (window as any).testScreenStop = () => {
          clearInterval(timer);
          stream.getVideoTracks()[0].stop();
          stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
        };
        return stream;
      };
    });
    await publisher
      .getByTestId("call-bar")
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    const captureAge = await contexts[1].pages()[0].evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const samples: number[] = [];
          let finished = false;
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 180;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          })!;
          const finish = () => {
            if (!finished) {
              finished = true;
              resolve(samples);
            }
          };
          setTimeout(finish, 6000);
          for (const video of document.querySelectorAll<HTMLVideoElement>(
            '[data-testid="remote-media"]',
          )) {
            const frame = () => {
              if (finished) return;
              if (video.videoWidth) {
                context.drawImage(video, 0, 0, 320, 180);
                const marker = context.getImageData(160, 130, 1, 1).data;
                if (marker[0] > 180 && marker[1] < 70 && marker[2] > 180) {
                  let value = 0;
                  for (let bit = 0; bit < 32; bit++) {
                    const pixel = context.getImageData(
                      bit * 10 + 5,
                      40,
                      1,
                      1,
                    ).data;
                    value = (value * 2 + (pixel[0] > 128 ? 1 : 0)) >>> 0;
                  }
                  const age = ((Date.now() >>> 0) - value) >>> 0;
                  if (age < 2000) samples.push(age);
                  if (samples.length >= 30) finish();
                }
              }
              video.requestVideoFrameCallback(frame);
            };
            video.requestVideoFrameCallback(frame);
          }
        }),
    );
    expect(
      captureAge.length,
      "Screen replacement must arrive and decode timestamp frames",
    ).toBeGreaterThanOrEqual(10);
    const sorted = [...captureAge].sort((a, b) => a - b);
    await writeFile(
      "test-results/client-screen-capture-latency.json",
      JSON.stringify(
        {
          note: "Synthetic canvas timestamp capture to decoded browser video callback over localhost SFU; same host wall clock. Excludes physical camera exposure, display scanout and real OS screen-capture permissions. Not physical glass-to-glass.",
          samplesMs: captureAge,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        },
        null,
        2,
      ),
    );
    await publisher.evaluate(() => (window as any).testScreenStop());
    for (const context of contexts) {
      const page = context.pages()[0];
      const bar = page.getByTestId("call-bar");
      await bar.getByRole("button", { name: "Leave", exact: true }).click();
      await expect(
        bar.getByRole("button", { name: "Join", exact: true }),
      ).toBeVisible();
    }
  } finally {
    const diagnostic = [];
    for (const context of contexts) {
      const page = context.pages()[0];
      if (page && !page.isClosed())
        diagnostic.push(
          await page
            .evaluate(async () => {
              const sample = [];
              for (const peer of (
                window as unknown as { testPeers: RTCPeerConnection[] }
              ).testPeers) {
                const stats = [];
                for (const stat of (await peer.getStats()).values())
                  if (
                    [
                      "inbound-rtp",
                      "outbound-rtp",
                      "codec",
                      "transport",
                    ].includes(stat.type)
                  )
                    stats.push(stat);
                sample.push({
                  connection: peer.connectionState,
                  signaling: peer.signalingState,
                  transceivers: peer
                    .getTransceivers()
                    .map((t) => ({
                      direction: t.direction,
                      currentDirection: t.currentDirection,
                      mid: t.mid,
                      senderKind: t.sender.track?.kind,
                      senderState: t.sender.track?.readyState,
                      receiverKind: t.receiver.track.kind,
                      receiverState: t.receiver.track.readyState,
                    })),
                  stats,
                });
              }
              return {
                peers: sample,
                channels: (
                  window as unknown as { testChannels: RTCDataChannel[] }
                ).testChannels.map((dc) => ({
                  label: dc.label,
                  state: dc.readyState,
                })),
                screen: document.querySelector('[data-testid="screen-voice"]')
                  ?.textContent,
              };
            })
            .catch(() => ({ error: "page unavailable" })),
        );
    }
    const server = await (
      await request.get(`/api/channels/${await loungeId(request, voiceHeaders ?? headers)}/voice/stats`, {
        headers: voiceHeaders ?? headers,
      })
    ).json();
    await writeFile(
      "test-results/client-voice-diagnostics.json",
      JSON.stringify({ browser: diagnostic, server }, null, 2),
    );
    for (const context of contexts) await context.close();
  }
});

test("call stage owns center", async ({ browser, request }) => {
  test.setTimeout(120000);
  let owner = await request.post("/api/setup", {
    data: { setup_token: "test-setup-token-at-least-32-characters", username: "owner", password, device_name: "stage fixture" },
  });
  if (owner.status() === 409) owner = await request.post("/api/login", { data: { username: "owner", password, device_name: "stage fixture" } });
  expect(owner.ok()).toBeTruthy();
  const session = await owner.json();
  const headers = { Authorization: `Bearer ${session.token}`, "X-Device-Key": session.device_key };
  const me = await (await request.get("/api/me", { headers })).json();
  test.skip(me.capabilities.voice !== true, "SFU transport not configured in this backend binary");
  const invitation = await (await request.post("/api/invites", { headers, data: { email: "fixture@example.test", expires_in_seconds: 3600 } })).json();
  expect((await request.post("/api/invites/accept", { data: { token: invitation.token, username: "stage_erin", password, device_name: "stage fixture" } })).ok()).toBeTruthy();
  const contexts: BrowserContext[] = [];
  try {
    for (const username of ["owner", "stage_erin"]) {
      const context = await browser.newContext({ permissions: ["camera", "microphone"] });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto("/");
      await fillSignIn(page, username, password);
      await logInButton(page).click();
      await expect(page.getByTestId("screen-composer")).toBeVisible({ timeout: 30000 });
    }
    const [host, guest] = contexts.map(context => context.pages()[0]);
    for (const page of [host, guest]) {
      const bar = page.getByTestId("call-bar");
      await joinLounge(page);
      await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    }
    // The stage is the center; the composer and the message list moved to the right column's Chat tab.
    await expect(host.locator(".hc-center [data-testid=call-stage]")).toBeVisible();
    await expect(host.locator(".hc-center [data-testid=screen-composer]")).toHaveCount(0);
    await expect(host.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(host.locator(".hc-center [data-testid=call-tile]")).toHaveCount(2, { timeout: 15000 });
    await expect(host.locator(".hc-center [data-testid=call-bar]")).toBeVisible();
    // A camera-off participant shows an avatar; turning the camera on shows the picture.
    const guestTile = host.locator(".hc-center [data-testid=call-tile]").filter({ hasText: "stage_erin" });
    await expect(guestTile).not.toHaveAttribute("data-picture", "");
    await guest.getByTestId("call-bar").getByRole("button", { name: "Camera on", exact: true }).click();
    await expect(guestTile).toHaveAttribute("data-picture", "", { timeout: 30000 });
    await expect(host.locator("[data-testid=remote-media]").first()).toBeAttached();
    // Chat from the side tab reaches the other participant's side tab.
    const text = `stage hello ${Date.now()}`;
    await host.locator(".hc-right textarea").fill(text);
    await host.locator(".hc-right textarea").press("Enter");
    await expect(host.locator(".hc-right").getByText(text)).toBeVisible();
    await expect(guest.locator(".hc-right").getByText(text)).toBeVisible({ timeout: 15000 });
    // Pin spotlights a tile; unpin returns to the grid.
    await guestTile.getByRole("button", { name: /^Pin / }).click();
    await expect(host.locator(".hc-stage__spot")).toBeVisible();
    await host.locator(".hc-stage__spot").getByRole("button", { name: /^Unpin / }).click();
    await expect(host.locator(".hc-stage__spot")).toHaveCount(0);
    // Leaving restores the normal layout.
    await host.getByTestId("call-bar").getByRole("button", { name: "Leave", exact: true }).click();
    await expect(host.locator(".hc-center [data-testid=screen-composer]")).toBeVisible();
    await expect(host.getByRole("tab", { name: "Chat", exact: true })).toHaveCount(0);
    await expect(host.getByTestId("call-bar").getByRole("button", { name: "Join", exact: true })).toBeVisible();
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("call stage on a phone: stage is the screen, chat opens as the sheet", async ({ browser, request }) => {
  test.setTimeout(120000);
  const setup = await request.post("/api/setup", {
    data: { setup_token: "test-setup-token-at-least-32-characters", username: "owner", password, device_name: "phone stage fixture" },
  });
  expect([200, 201, 409]).toContain(setup.status());
  const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await fillSignIn(page, "owner", password);
    await logInButton(page).click();
    await expect(page.getByTestId("screen-composer")).toBeVisible();
    await openMenu(page);
    const bar = page.getByTestId("call-bar");
    await joinLounge(page);
    await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    await expect(page.locator(".hc-center [data-testid=call-stage]")).toBeVisible();
    await expect(page.locator(".hc-center [data-testid=screen-composer]")).toHaveCount(0);
    await bar.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".hc-right [data-testid=screen-composer]")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.locator(".hc-right").getByRole("button", { name: "Close", exact: true }).click();
    await bar.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.locator(".hc-center [data-testid=screen-composer]")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("joins and shows a warning when a saved device is missing",async ({ browser, request }) => {
  const setup = await request.post("/api/setup", {
    data: { setup_token: "test-setup-token-at-least-32-characters", username: "owner", password, device_name: "missing device fixture" },
  });
  expect([200, 201, 409]).toContain(setup.status());
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    // A saved microphone that is no longer plugged in: listed once, rejected by capture.
    await context.addInitScript(() => {
      const list = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async () => [
        ...(await list()),
        { deviceId: "does-not-exist", kind: "audioinput", label: "Unplugged microphone", groupId: "gone", toJSON: () => ({}) } as MediaDeviceInfo,
      ];
    });
    const page = await context.newPage();
    await page.goto("/");
    await fillSignIn(page, "owner", password);
    await logInButton(page).click();
    await expect(page.getByTestId("screen-composer")).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("screen-settings");
    await settings.getByRole("button", { name: "Audio and video", exact: true }).click();
    await settings.getByLabel("Microphone").selectOption("does-not-exist");
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    const bar = page.getByTestId("call-bar");
    await joinLounge(page);
    await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    await expect(page.getByText("Call failed")).toHaveCount(0);
    await expect(bar.getByRole("status")).toContainText("Using the default device");
    await bar.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(bar.getByRole("status")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
