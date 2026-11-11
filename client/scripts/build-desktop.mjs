import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

function npmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  if (process.platform === "win32") {
    const candidate = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  } else {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, "npm");
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      if (resolved.endsWith("npm-cli.js")) return resolved;
    }
  }
  throw new Error("Could not locate npm-cli.js; install npm with Node.js or run from an npm script");
}

const env = { ...process.env };
// VITE_API_ORIGIN is optional; set it to bake a default server origin into a desktop build.
const result = spawnSync(process.execPath, [npmCli(), "run", "build"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
