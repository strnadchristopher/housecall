import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const directory = await mkdtemp(join(tmpdir(), "chriscord-e2e-"));
const binary =
  process.env.CHRISCORD_TEST_BINARY ??
  resolve("../target/debug/chriscord-server");
const child = spawn(binary, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    CHRISCORD_BIND: "127.0.0.1:3031",SFU_BIND:"127.0.0.1:50010",SFU_PUBLIC_IP:"127.0.0.1",
    CHRISCORD_ORIGIN: "http://localhost:1420",
    CHRISCORD_DATABASE: join(directory, "database.sqlite"),
    CHRISCORD_MEDIA_DIR: join(directory, "media"),
    CHRISCORD_MEDIA_KEY: "11".repeat(32),
    CHRISCORD_SETUP_TOKEN: "test-setup-token-at-least-32-characters",
  },
});
let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
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
