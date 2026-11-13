// Keeps docs/design/HC-040.md and design/040/css/*.css in step: the CSS lives once, in the css files the
// mockups load, and is copied into the spec between markers.
//
//   <!-- css: design/040/css/03-sidebar.css -->      everything up to the matching <!-- /css --> is replaced
//   <!-- icons -->  ...  <!-- /icons -->             the PLAN and NEW rows of design/040/icons.js, as kit.tsx lines
//
// Lines marked "mock-only" are left out of the spec. Run: node design/040/sync-spec.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const specPath = join(root, "docs/design/HC-040.md");
let spec = readFileSync(specPath, "utf8");
let blocks = 0;

spec = spec.replace(/<!-- css: (\S+) -->[\s\S]*?<!-- \/css -->/g, (_, file) => {
  const css = readFileSync(join(root, file), "utf8").split("\n").filter(line => !line.includes("mock-only")).join("\n").trim();
  blocks++;
  return `<!-- css: ${file} -->\n\`\`\`css\n${css}\n\`\`\`\n<!-- /css -->`;
});

spec = spec.replace(/<!-- icons -->[\s\S]*?<!-- \/icons -->/g, () => {
  const source = readFileSync(join(root, "design/040/icons.js"), "utf8");
  const from = source.indexOf("// ---- PLAN");
  const lines = source.slice(from, source.lastIndexOf("};")).split("\n").map(line => line.replace(/^  /, "")).join("\n").trim();
  blocks++;
  return `<!-- icons -->\n\`\`\`ts\n${lines}\n\`\`\`\n<!-- /icons -->`;
});

writeFileSync(specPath, spec);
console.log(`${blocks} blocks synced into docs/design/HC-040.md`);
