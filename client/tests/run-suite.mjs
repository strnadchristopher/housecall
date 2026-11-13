// Runs one Playwright suite chosen by its flag: node tests/run-suite.mjs HOUSECALL_TEST_VOICECHANNELS [playwright args]
// (no argument: the default chat suite). Keeps the env var out of the shell command line.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [flag, ...rest] = process.argv.slice(2);
const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...rest], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(flag ? { [flag]: "1" } : {}) },
});
child.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
