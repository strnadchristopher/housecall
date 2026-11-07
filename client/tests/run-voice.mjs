import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    process.env.CHRISCORD_TEST_LOAD === "1"
      ? "voice-load.spec.ts"
      : "voice.spec.ts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, CHRISCORD_TEST_VOICE: "1" } },
);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
