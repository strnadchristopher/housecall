import { expect, it } from 'vitest';
import vector from './vectors/link-v1.json';
it('QR codec round trip, quiet zone and hostile frames', async () => {
  const { decodeQr, renderQr } = await import('../src/data/qr');
  const rendered = renderQr(vector.qr_text); expect(rendered.ok).toBe(true); if (!rendered.ok) throw rendered.error;
  const { modules, quietZone } = rendered.value; expect(quietZone).toBe(4);
  expect(modules.slice(0, 4).flat().some(Boolean)).toBe(false); expect(modules.slice(-4).flat().some(Boolean)).toBe(false);
  for (const row of modules) { expect(row.slice(0, 4).some(Boolean)).toBe(false); expect(row.slice(-4).some(Boolean)).toBe(false); }
  const scale = 6, width = modules.length * scale, data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) { if (modules[Math.floor(y / scale)][Math.floor(x / scale)]) { const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; } }
  expect(decodeQr({ width, height: width, data })).toEqual({ ok: true, value: vector.qr_text });
  expect(decodeQr({ width: 0, height: 1, data }).ok).toBe(false);
  expect(decodeQr({ width: 2, height: 2, data: new Uint8ClampedArray(3) }).ok).toBe(false);
  expect(renderQr('not a login code').ok).toBe(false);
  expect(decodeQr({ width: 100, height: 100, data: new Uint8ClampedArray(40000).fill(255) })).toEqual({ ok: true, value: null });
});
