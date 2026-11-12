import { spawn } from "node:child_process";
// Adversarial UX walk-through (persona Linda) at 390x844. Writes docs/ux/<out>, default mobile-baseline:
//   npm run test:linda -- mobile-after-part1
const [out = "mobile-baseline", ...rest] = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "linda.spec.ts", ...rest],
  { stdio: "inherit", env: { ...process.env, HOUSECALL_TEST_LINDA: "1", HOUSECALL_UX_OUT: out } },
);
child.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
