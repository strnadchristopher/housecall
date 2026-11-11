import { spawn } from "node:child_process";
// Scripted Dana run: voice and the synthetic Plex fixture are on. Rewrites docs/ux/phase-2.
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "dana.spec.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, HOUSECALL_TEST_VOICE: "1", HOUSECALL_TEST_PLEX: "1", HOUSECALL_TEST_DANA: "1" } },
);
child.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
