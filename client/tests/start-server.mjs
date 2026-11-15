import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const stopPlex =
  process.env.HOUSECALL_TEST_PLEX === "1"
    ? await (await import("./plex-fixture.mjs")).startPlexFixture()
    : undefined;
const directory = await mkdtemp(join(tmpdir(), "housecall-e2e-"));
const wantsScanner = process.env.HOUSECALL_TEST_SECURITY === "1" || process.env.HOUSECALL_TEST_REPORTS === "1" || process.env.HOUSECALL_TEST_UPLOAD_VIDEO === "1" || process.env.HOUSECALL_TEST_UPLOADS === "1" || process.env.HOUSECALL_TEST_SNAPS === "1" || process.env.HOUSECALL_TEST_SHOTS === "1" || process.env.HOUSECALL_TEST_PROFILE === "1" || process.env.HOUSECALL_TEST_UIFIX === "1";
// Real ClamAV when its socket exists; otherwise a local INSTREAM stand-in (OK unless EICAR).
let clamdSocket = resolve("../.runtime/scan/clamd.sock");
let stopClamd;
if (wantsScanner && !existsSync(clamdSocket)) {
  clamdSocket = join(directory, "clamd.sock");
  stopClamd = await (await import("./clamd-fixture.mjs")).startClamdFixture(clamdSocket);
}
const binary =
  process.env.HOUSECALL_TEST_BINARY ??
  resolve("../target/debug/housecall-server");
const child = spawn(binary, [], {
  stdio: "inherit",
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HOUSECALL_|SFU_|PLEX_|GIMME_|GIPHY_|SWITCHBOARD_|PUSH_|APNS_|FCM_|DJ_|SPOTIFY_|YT_DLP_|RESEND_)/.test(key))),
    GIMME_DRY_RUN: "true",
    DJ_ENABLED: "false",
    ...(wantsScanner ? { HOUSECALL_CLAMD_SOCKET: clamdSocket } : {}),
    HOUSECALL_BIND: "127.0.0.1:3031",
    ...(process.env.HOUSECALL_TEST_PHASE4 === "1" || process.env.HOUSECALL_TEST_VOICE === "1" || process.env.HOUSECALL_TEST_DM_CALLS === "1" || process.env.HOUSECALL_TEST_VOICECHANNELS === "1" || process.env.HOUSECALL_TEST_VOICESHOTS === "1" || process.env.HOUSECALL_TEST_MEDIASHOTS === "1" || process.env.HOUSECALL_TEST_SHELL === "1" || process.env.HOUSECALL_TEST_SHOTS === "1"
      ? { SFU_BIND: "127.0.0.1:50010", SFU_PUBLIC_IP: "127.0.0.1" }
      : {}),
    ...(process.env.HOUSECALL_TEST_PLEX === "1"
      ? { PLEX_URL: "http://127.0.0.1:3032", PLEX_TOKEN: "fixture-secret" }
      : {}),
    HOUSECALL_ORIGIN: "http://localhost:1420",
    HOUSECALL_PUBLIC_URL: "http://localhost:1420",
    HOUSECALL_DATABASE: join(directory, "database.sqlite"),
    HOUSECALL_MEDIA_DIR: join(directory, "media"),
    HOUSECALL_MEDIA_KEY: "11".repeat(32),
    HOUSECALL_SETUP_TOKEN: "test-setup-token-at-least-32-characters",
  },
});
if (process.env.HOUSECALL_TEST_PID_PATH && child.pid)
  await writeFile(process.env.HOUSECALL_TEST_PID_PATH, String(child.pid));
let cleaning;
function cleanup() {
  return cleaning ??= (async()=>{
    child.kill("SIGTERM");
    if (process.env.HOUSECALL_TEST_PID_PATH) await rm(process.env.HOUSECALL_TEST_PID_PATH, { force: true });
    await stopPlex?.();
    await stopClamd?.();
    await rm(directory, { recursive: true, force: true });
  })();
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => void cleanup());
child.on("error", async (error) => {
  console.error(`Unable to start backend test fixture: ${error.message}`);
  await cleanup();
  process.exit(1);
});
child.on("exit", async (code) => {
  await cleanup();
  process.exit(code ?? 0);
});
