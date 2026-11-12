import { spawn } from "node:child_process";
// Runs one env-gated Playwright suite: `node tests/run-e2e.mjs MOBILE` is `HOUSECALL_TEST_MOBILE=1 npm run e2e`.
// For shells and sandboxes that can't set an environment variable in front of a command.
const [suite, ...rest] = process.argv.slice(2);
if (!suite || !/^[A-Z_]+$/.test(suite)) {
  console.error("usage: node tests/run-e2e.mjs <SUITE> [playwright args], e.g. SHELL, MOBILE, ONBOARDING");
  process.exit(2);
}
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...rest],
  { stdio: "inherit", env: { ...process.env, [`HOUSECALL_TEST_${suite}`]: "1" } },
);
child.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
