// Minimal codec boundary types, usable before the blocked offline install completes.
declare module 'qrcode-generator' {
  interface QRCode { addData(text: string, mode?: 'Byte'): void; make(): void; getModuleCount(): number; isDark(row: number, col: number): boolean }
  export default function qrcode(typeNumber: number, errorCorrectionLevel: 'M'): QRCode;
}
declare module 'jsqr' {
  export default function jsQR(data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: 'attemptBoth' }): { data: string } | null;
}
