// Isolated test process. Uses only synthetic private files supplied by the test.
import { readFileSync } from 'node:fs';
import * as opaque from '@serenity-kit/opaque';
import { Store } from '../src/storage.mjs';
import { createPortal } from '../src/service.mjs';
await opaque.ready;
const secrets = JSON.parse(readFileSync(process.env.PORTAL_SECRETS_FILE, 'utf8'));
const store = new Store(process.env.PORTAL_STATE);
let tick = 0;
const server = createPortal({ opaque, store, ...secrets, origin: 'https://portal.example', registrationOpen: true, now: () => performance.now() + tick });
process.on('message', message => { if (message.advance) { tick += message.advance; process.send({ advanced: true }); } });
server.on('error', () => { process.send({ error: 'Loopback listening unavailable' }); store.close(); process.exit(1); });
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('SIGTERM', () => { server.close(() => { store.close(); process.exit(0); }); server.closeAllConnections(); });
