import { spawn } from "node:child_process";
// Screenshot run. Rewrites the tracked PNGs in design/shots; never part of an acceptance run.
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "shots.spec.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, HOUSECALL_TEST_SHOTS: "1" } },
);
child.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
