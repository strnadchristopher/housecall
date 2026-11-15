/** HC-040 7.4: alongside the source column, eight pixels inside the viewport. */
export function personCardPosition(anchor: { left: number; right: number; top: number }, height: number, width: number, viewportHeight: number, fromRight: boolean) {
  return {
    left: Math.max(8, Math.min(fromRight ? anchor.left - 280 - 8 : anchor.right + 8, width - 280 - 8)),
    top: Math.max(8, Math.min(anchor.top, viewportHeight - height - 8)),
  };
}
