// Socket-free actual Store process for Linux ownership/crash regression.
import { Store } from '../src/storage.mjs';
const store = new Store(process.env.PORTAL_STATE);
process.on('message', message => {
  if (message.row) store.set(message.index, message.row);
  process.send({ accounts: Object.fromEntries(store.accounts) });
});
process.send({ ready: true });
process.on('SIGTERM', () => { store.close(); process.exit(0); });
