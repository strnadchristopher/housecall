import { spawnSync } from "node:child_process";

const env = { ...process.env };
env.VITE_API_ORIGIN ||= "https://chriscord.littleobelisk.com";
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
