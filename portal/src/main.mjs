import { readFileSync } from 'node:fs';
import { Store, privateFile } from './storage.mjs';
import { createPortal } from './service.mjs';
let store;
try {
  const opaque = await import('@serenity-kit/opaque'); await opaque.ready;
  const path = process.env.PORTAL_SECRETS_FILE;
  privateFile(path);
  const secrets = JSON.parse(readFileSync(path, 'utf8'));
  store = new Store(process.env.PORTAL_STATE);
  const port = Number(process.env.PORTAL_PORT || 43180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = createPortal({ opaque, store, ...secrets, origin: process.env.PORTAL_ORIGIN, registrationOpen: process.env.PORTAL_REGISTRATION_OPEN === 'yes-reviewed', proxy: process.env.PORTAL_LOOPBACK_PROXY === 'yes' });
  server.on('error', () => { store.close(); process.stderr.write('Portal could not listen.\n'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write('Portal listening on loopback.\n'));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return; stopping = true;
    server.close(() => { store.close(); process.exit(0); }); server.closeAllConnections();
  });
} catch {
  store?.close(); process.stderr.write('Portal startup refused. Check dependency, private setup, state lock and configuration.\n'); process.exitCode = 1;
}
