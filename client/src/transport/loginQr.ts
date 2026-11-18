/** Login/unlock scanning belongs only to the native phone app, never a browser or desktop. */
export function canScanLoginQr(native: boolean): boolean {
  return native && typeof navigator !== 'undefined' && /android|iphone|ipad/i.test(navigator.userAgent);
}
