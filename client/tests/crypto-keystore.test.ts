import { expect, it } from 'vitest';
import { MemoryKeyStore } from '../src/crypto/keystore';
it('keeps identity in memory, clones reads/writes and clears both API aliases', async () => {
  const store = new MemoryKeyStore(), seed = new Uint8Array(32).fill(7);
  expect(await store.load()).toBeNull(); await store.save({ seed, recoveryRev: 1 }); seed.fill(0);
  const value = (await store.get())!; expect(value.seed[0]).toBe(7); value.seed.fill(0);
  expect((await store.load())!.seed[0]).toBe(7);
  await store.set({ seed: new Uint8Array(32).fill(8), recoveryRev: 2 }); expect((await store.load())!.recoveryRev).toBe(2);
  await store.remove(); expect(await store.load()).toBeNull();
  await expect(store.save({ seed: new Uint8Array(31), recoveryRev: 1 })).rejects.toThrow();
  await expect(store.save({ seed, recoveryRev: 0 })).rejects.toThrow();
  expect(await new MemoryKeyStore().load()).toBeNull();
});
