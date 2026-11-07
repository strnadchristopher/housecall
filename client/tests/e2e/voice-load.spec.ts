import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile),
  password = "correct horse battery staple";
async function resources() {
  const rows = (await execute("ps", ["-eo", "comm=,rss=,%cpu="])).stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => /chrom|chriscord/.test(row[0]));
  const memory = await readFile("/proc/meminfo", "utf8");
  const membership = await readFile("/proc/self/cgroup", "utf8");
  const group = membership.split("\n").find(line => line.startsWith("0::"))?.slice(3);
  // A dedicated bounded test unit excludes unrelated desktop Chrome processes.
  const dedicated = group?.includes("chriscord-voice-load") ?? false;
  const cgroupMiB = dedicated ? Number(await readFile(`/sys/fs/cgroup${group}/memory.current`, "utf8")) / 1024 / 1024 : null;
  const cpuStat = dedicated ? await readFile(`/sys/fs/cgroup${group}/cpu.stat`, "utf8") : "";

  return {
    at: Date.now(),
    cgroupMiB,
    cgroupCpuUsec: Number(cpuStat.match(/usage_usec\s+(\d+)/)?.[1] ?? 0),
    rssMiB: Math.round(
      rows.reduce((sum, row) => sum + Number(row[1]), 0) / 1024,
    ),
    cpuPercent: rows.reduce((sum, row) => sum + Number(row[2]), 0),
    availableMiB: Math.round(
      Number(memory.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024,
    ),
  };
}
async function media(page: Page) {
  return page.evaluate(async () => {
    let video = 0,
      audio = 0,
      frames = 0,
      bytes = 0;
    for (const peer of (window as any).loadPeers as RTCPeerConnection[])
      for (const stat of (await peer.getStats()).values())
        if (stat.type === "inbound-rtp") {
          if (stat.kind === "video" && stat.framesDecoded > 0) video++;
          if (stat.kind === "audio" && stat.packetsReceived > 0) audio++;
          frames += stat.framesDecoded ?? 0;
          bytes += stat.bytesReceived ?? 0;
        }
    return { video, audio, frames, bytes };
  });
}
test("bounded thirty-peer real RTP load at 320x180 five fps", async ({
  browser,
  request,
}) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  const stages: unknown[] = [];
  const samples: Awaited<ReturnType<typeof resources>>[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const before = await resources();
  expect(
    before.availableMiB,
    "Load needs at least 3 GiB available RAM",
  ).toBeGreaterThan(3072);
  try {
    const setup = await request.post("/api/setup", {
      data: {
        setup_token: "test-setup-token-at-least-32-characters",
        username: "load_owner",
        password,
        device_name: "load fixture",
      },
    });
    expect(setup.ok()).toBeTruthy();
    const owner = await setup.json();
    const headers = {
      Authorization: `Bearer ${owner.token}`,
      "X-Device-Key": owner.device_key,
    };
    for (let index = 0; index < 30; index++) {
      const invite = await (
        await request.post("/api/invites", {
          headers,
          data: { expires_in_seconds: 3600 },
        })
      ).json();
      const accepted = await request.post("/api/invites/accept", {
        data: {
          token: invite.token,
          username: `load_${index}`,
          password,
          device_name: "load fixture",
        },
      });
      expect(accepted.ok()).toBeTruthy();
      const session = await accepted.json();
      const context = await browser.newContext({
        permissions: ["camera", "microphone"],
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto("/");
      await page.evaluate(
        async (session) => {
          const original = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
          navigator.mediaDevices.getUserMedia = (constraints) =>
            original({
              ...constraints,
              video: {
                width: { exact: 320 },
                height: { exact: 180 },
                frameRate: { exact: 5 },
              },
            });
          const Base = RTCPeerConnection;
          const peers: RTCPeerConnection[] = [];
          (window as any).loadPeers = peers;
          window.RTCPeerConnection = class extends Base {
            constructor(configuration?: RTCConfiguration) {
              super(configuration);
              peers.push(this);
            }
          };
          const { Api } = await import("/src/transport/api.ts" as string);
          const { VoiceSession } = await import(
            "/src/transport/voice.ts" as string
          );
          const api = new Api();
          api.authenticate(session);
          const elements = new Map<string, HTMLVideoElement>();
          (window as any).loadVoice = new VoiceSession(api, (state: any) => {
            for (const stream of state.streams as MediaStream[])
              if (!elements.has(stream.id)) {
                const element = document.createElement("video");
                element.autoplay = true;
                element.srcObject = stream;
                document.body.append(element);
                elements.set(stream.id, element);
                void element.play().catch(() => {});
              }
          });
        },
        { token: session.token, device_key: session.device_key },
      );
    }
    timer = setInterval(
      () => void resources().then((sample) => samples.push(sample)),
      2000,
    );
    const started = Date.now(),
      deadline = started + 60000;
    let joined = 0;
    for (const count of [5, 10, 20, 30]) {
      for (; joined < count; joined++) {
        const memory = await resources();
        samples.push(memory);
        expect(
          memory.availableMiB,
          "Abort before memory exhaustion",
        ).toBeGreaterThan(1536);
        expect(
          memory.cgroupMiB ?? (memory.rssMiB - before.rssMiB),
          "Bound dedicated test cgroup (or incremental process RSS) to 6 GiB",
        ).toBeLessThan(6144);
        expect(Date.now(), "60 second media load deadline").toBeLessThan(
          deadline,
        );
        await Promise.race([
          contexts[joined]
            .pages()[0]
            .evaluate(() => (window as any).loadVoice.join("general", true)),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Join exceeded ten seconds")),
              10000,
            ),
          ),
        ]);
      }
      let peers = await Promise.all(
        contexts.slice(0, count).map((context) => media(context.pages()[0])),
      );
      const settleDeadline = Math.min(deadline, Date.now() + 7000);
      while (
        peers.some(
          (peer) => peer.video < count - 1 || peer.audio < count - 1,
        ) &&
        Date.now() < settleDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        peers = await Promise.all(
          contexts.slice(0, count).map((context) => media(context.pages()[0])),
        );
      }
      stages.push({
        count,
        elapsedMs: Date.now() - started,
        peers,
        resources: await resources(),
      });
      expect(
        peers.every(
          (peer) => peer.video === count - 1 && peer.audio === count - 1,
        ),
        `${count} peers must each decode every other peer`,
      ).toBeTruthy();
    }
  } finally {
    clearInterval(timer);
    await writeFile(
      "../evidence/client-voice-load.json",
      JSON.stringify(
        {
          profile: {
            peers: 30,
            width: 320,
            height: 180,
            framesPerSecond: 5,
            opusTargetBps: 510000,
            loadDeadlineMs: 60000,
          },
          note: "Real Chromium fake-capture RTP through the Rust SFU at reduced video resolution/frame rate. Not a production 720p or physical glass-to-glass claim. Dedicated systemd cgroup memory/CPU excludes unrelated browsers; ps CPU is lifetime average and summed RSS includes background browsers/shared pages. The first failed attempt incorrectly applied an absolute summed-RSS guard to unrelated Chrome processes.",
          before,
          stages,
          samples,
        },
        null,
        2,
      ),
    );
    for (const context of contexts) await context.close();
  }
});
