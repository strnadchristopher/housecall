/** A cancellable touch hold. Pointer movement is measured from the initial point, in CSS pixels. */
export class LivePress {
  private timer?: ReturnType<typeof setTimeout>;
  private origin?: { x: number; y: number };
  private swallow = false;
  start(x: number, y: number, open: () => void) {
    this.cancel();
    this.swallow = false;
    this.origin = { x, y };
    this.timer = setTimeout(() => { this.timer = undefined; this.swallow = true; open(); }, 450);
  }
  move(x: number, y: number) {
    if (this.origin && Math.hypot(x - this.origin.x, y - this.origin.y) >= 8) {
      this.cancel();
      this.swallow = true;
    }
  }
  cancel() { clearTimeout(this.timer); this.timer = undefined; this.origin = undefined; }
  consumeClick() { const swallow = this.swallow; this.swallow = false; return swallow; }
}
