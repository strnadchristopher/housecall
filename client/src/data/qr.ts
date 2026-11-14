// Runtime dependencies: qrcode-generator@2.0.4 and jsqr@1.4.0. See phase receipt.
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { attempt, requireThat, unwrap, type Result } from '../crypto/common';
import { parseQr } from '../crypto/link';
export interface QrMatrix { modules: boolean[][]; quietZone: 4 }
/** Matrix includes a four-module light quiet zone on all sides; no DOM/canvas work. */
export function renderQr(payload: string): Result<QrMatrix> {
  return attempt(() => {
    unwrap(parseQr(payload));
    const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make();
    const count = qr.getModuleCount(), size = count + 8;
    return { quietZone: 4 as const, modules: Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => y >= 4 && x >= 4 && y < count + 4 && x < count + 4 && qr.isDark(y - 4, x - 4))) };
  });
}
/** Structural ImageData input also runs in Node; only valid Housecall payloads are returned. */
export function decodeQr(frame: Pick<ImageData, 'data' | 'width' | 'height'>): Result<string | null> {
  return attempt(() => {
    requireThat(frame && Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0);
    requireThat(frame.data instanceof Uint8ClampedArray && frame.width * frame.height * 4 === frame.data.length);
    const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
    if (!found) return null;
    unwrap(parseQr(found.data)); return found.data;
  });
}
