// Verify the client stage's source closure without Docker, downloads or a Rust build.
// Installed JS dependencies are reused; repository source is copied into an isolated tree.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const isolated = mkdtempSync(join(tmpdir(), 'housecall-docker-client-'));
try {
  cpSync(join(root, 'client'), join(isolated, 'client'), {
    recursive: true,
    filter: path => !['node_modules', 'dist', 'dist-hosted', 'test-results', 'hosted-evidence'].includes(basename(path)),
  });
  const docker = readFileSync(join(root, 'Dockerfile'), 'utf8').split('FROM rust:')[0];
  const copies = docker.split('\n').filter(line => line.startsWith('COPY portal/'));
  if (copies.length !== 1) throw new Error('Review changed client-stage source COPY rules');
  const [, ...args] = copies[0].split(/\s+/);
  const destination = args.pop();
  if (destination !== '/build/portal/src/') throw new Error('Unexpected client-stage destination');
  for (const source of args) {
    const target = join(isolated, 'portal/src', basename(source));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(root, source), target);
  }
  symlinkSync(join(root, 'client/node_modules'), join(isolated, 'client/node_modules'), 'dir');
  const result = spawnSync('npm', ['run', 'build'], { cwd: join(isolated, 'client'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated client build failed (${result.status})`);
  console.log('Docker-style isolated client source closure passed (reused installed JS dependencies).');
} finally { rmSync(isolated, { recursive: true, force: true }); }
