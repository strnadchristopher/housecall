import { mkdirSync, cpSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(root + 'dist', { recursive: true });
for (const name of ['index.html', 'styles.css']) copyFileSync(root + 'public/' + name, root + 'dist/' + name);
for (const name of ['app', 'account-client', 'direct', 'vault', 'device-vault', 'account-identity']) copyFileSync(root + 'src/' + name + '.mjs', root + 'dist/' + name + '.mjs');
cpSync(root + 'public/assets', root + 'dist/assets', { recursive: true });
const dependency = root + 'node_modules/@serenity-kit/opaque/';
if (existsSync(dependency + 'esm/index.js')) {
  const pkg = JSON.parse(readFileSync(dependency + 'package.json', 'utf8'));
  if (pkg.version !== '1.1.0' || pkg.license !== 'MIT') throw new Error('Unexpected OPAQUE artifact');
  copyFileSync(dependency + 'esm/index.js', root + 'dist/opaque.mjs');
  copyFileSync(dependency + 'LICENSE', root + 'dist/OPAQUE-LICENSE.txt');
} else {
  // Dynamic import fails honestly if auth is requested; direct connection has no dependency.
  writeFileSync(root + 'dist/opaque.mjs', 'throw new Error("Account dependency unavailable");\n');
}
console.log('Portal static build complete. Registration remains an operator gate.');
