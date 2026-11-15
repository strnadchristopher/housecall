/** HC-040 18.2: fit 16:9 tiles to the space the shell actually gives the stage. */
export function stageGrid(count: number, width: number, height: number, gap = 12) {
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const tile = Math.min((width - gap * (cols - 1)) / cols, ((height - gap * (rows - 1)) / rows) * (16 / 9));
    if (tile > best.tile) best = { cols, tile };
  }
  return { cols: best.cols, tile: Math.max(0, Math.floor(Math.min(best.tile, 640))) };
}
