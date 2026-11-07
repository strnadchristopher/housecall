import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const stopPlex =
  process.env.CHRISCORD_TEST_PLEX === "1"
    ? await (await import("./plex-fixture.mjs")).startPlexFixture()
    : undefined;
const directory = await mkdtemp(join(tmpdir(), "chriscord-e2e-"));
const binary =
  process.env.CHRISCORD_TEST_BINARY ??
  resolve("../target/debug/chriscord-server");
const child = spawn(binary, [], {
  stdio: "inherit",
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHRISCORD_|SFU_|PLEX_|GIMME_|GIPHY_|SWITCHBOARD_|DJ_|SPOTIFY_|YT_DLP_)/.test(key))),
    GIMME_DRY_RUN: "true",
    DJ_ENABLED: "false",
    ...(process.env.CHRISCORD_TEST_REPORTS === "1"
      ? { CHRISCORD_CLAMD_SOCKET: resolve("../.runtime/scan/clamd.sock") }
      : {}),
    CHRISCORD_BIND: "127.0.0.1:3031",
    ...(process.env.CHRISCORD_TEST_VOICE === "1"
      ? { SFU_BIND: "127.0.0.1:50010", SFU_PUBLIC_IP: "127.0.0.1" }
      : {}),
    ...(process.env.CHRISCORD_TEST_PLEX === "1"
      ? { PLEX_URL: "http://127.0.0.1:3032", PLEX_TOKEN: "fixture-secret" }
      : {}),
    CHRISCORD_ORIGIN: "http://localhost:1420",
    CHRISCORD_DATABASE: join(directory, "database.sqlite"),
    CHRISCORD_MEDIA_DIR: join(directory, "media"),
    CHRISCORD_MEDIA_KEY: "11".repeat(32),
    CHRISCORD_SETUP_TOKEN: "test-setup-token-at-least-32-characters",
  },
});
let cleaning;
function cleanup() {
  return cleaning ??= (async()=>{
    child.kill("SIGTERM");
    await stopPlex?.();
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
