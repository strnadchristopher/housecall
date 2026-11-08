import type { ReactNode, SVGProps } from 'react';

/**
 * Chriscord house icons. Drawn on a 20px grid in one construction:
 * faceted geometry. Rectangles take a 2px chamfer instead of a radius,
 * circles are cut as octagons, and dots are diamonds. Miter joins, butt caps.
 * Nothing here comes from an icon pack.
 */

type P = [number, number][];
const pts = (p: P) => p.map(([x, y]) => `${x},${y}`).join(' ');

/** Chamfered rectangle as polygon points. */
function crect(x: number, y: number, w: number, h: number, c = 2): string {
  return pts([[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]]);
}
/** Octagon with flats on the axes ("cut circle"). */
function oct(cx: number, cy: number, r: number): string {
  const k = r * 0.4142;
  return pts([[cx - k, cy - r], [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy + k], [cx + k, cy + r], [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy - k]]);
}
function diamond(cx: number, cy: number, r: number): string {
  return pts([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
}
function cog(cx: number, cy: number): string {
  const out: P = [];
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const step = Math.PI / teeth;
    const ring: [number, number][] = [[a - step * 0.42, 7.4], [a + step * 0.42, 7.4], [a + step * 0.6, 5.6], [a + step * 1.4, 5.6]];
    for (const [aa, r] of ring) out.push([+(cx + Math.cos(aa) * r).toFixed(2), +(cy + Math.sin(aa) * r).toFixed(2)]);
  }
  return pts(out);
}

const slash = <polyline points="3.5,3.5 16.5,16.5" />;

export const iconPaths = {
  hash: <><polyline points="8,3 6.5,17" /><polyline points="13.5,3 12,17" /><polyline points="3.5,7.5 16.5,7.5" /><polyline points="3.5,12.5 16.5,12.5" /></>,
  voice: <><polygon points="3,7.5 6.2,7.5 10.5,4 10.5,16 6.2,12.5 3,12.5" /><polyline points="13,7.2 14.4,8.6 14.4,11.4 13,12.8" /><polyline points="15.4,4.8 17.2,7.2 17.2,12.8 15.4,15.2" /></>,
  at: <><polygon points={oct(10, 10, 3)} /><polyline points="13,7 13,11.6 14.4,13 15.6,13 17,11.6 17,7.1 12.9,3 7.1,3 3,7.1 3,12.9 7.1,17 13,17" /></>,
  smile: <><polygon points={oct(10, 10, 7)} /><polygon className="f" points={diamond(7.6, 8.4, 1)} /><polygon className="f" points={diamond(12.4, 8.4, 1)} /><polyline points="6.8,11.6 8.4,13.2 11.6,13.2 13.2,11.6" /></>,
  reply: <><polyline points="8,4.5 3.5,9 8,13.5" /><polyline points="3.5,9 12.5,9 15.5,12 15.5,16" /></>,
  thread: <><polygon points="3,3.5 12,3.5 14,5.5 14,10 12,12 7.5,12 4.5,15 4.5,12 3,12" /><polyline points="16.5,7.5 17,8 17,14 15.5,14 15.5,16.5 12.5,14 9.5,14" /></>,
  pin: <><polygon points="7,3 13,3 12,7.8 14.6,11 5.4,11 8,7.8" /><polyline points="10,11 10,17.5" /></>,
  search: <><polygon points={oct(8.5, 8.5, 5.2)} /><polyline points="12.3,12.3 17,17" /></>,
  members: <><polygon points={oct(7.5, 6.5, 2.8)} /><polyline points="2.5,16.5 2.5,14.4 4.6,11.8 10.4,11.8 12.5,14.4 12.5,16.5" /><polyline points="12.6,3.9 13.6,3.7 16.1,5.6 16.1,7.4 14.2,9.4" /><polyline points="14.5,11.8 15.4,11.8 17.5,14.4 17.5,16.5" /></>,
  gear: <><polygon points={cog(10, 10)} /><polygon points={oct(10, 10, 2.4)} /></>,
  mic: <><polygon points={crect(7.25, 2.5, 5.5, 9.5, 2)} /><polyline points="4.5,8.8 4.5,10.6 7,13.6 13,13.6 15.5,10.6 15.5,8.8" /><polyline points="10,13.6 10,17" /><polyline points="7,17 13,17" /></>,
  micOff: <><polygon points={crect(7.25, 2.5, 5.5, 9.5, 2)} /><polyline points="4.5,8.8 4.5,10.6 7,13.6 13,13.6 15.5,10.6 15.5,8.8" /><polyline points="10,13.6 10,17" /><polyline points="7,17 13,17" />{slash}</>,
  headphones: <><polyline points="3.5,13 3.5,8 7,3.8 13,3.8 16.5,8 16.5,13" /><polygon className="f" points="3,10.5 6.8,10.5 6.8,17 3,17" /><polygon className="f" points="13.2,10.5 17,10.5 17,17 13.2,17" /></>,
  deafen: <><polyline points="3.5,13 3.5,8 7,3.8 13,3.8 16.5,8 16.5,13" /><polygon className="f" points="3,10.5 6.8,10.5 6.8,17 3,17" /><polygon className="f" points="13.2,10.5 17,10.5 17,17 13.2,17" />{slash}</>,
  camera: <><polygon points={crect(2.5, 5.5, 10.5, 9, 2)} /><polygon points="13,8.6 17.5,6.2 17.5,13.8 13,11.4" /></>,
  cameraOff: <><polygon points={crect(2.5, 5.5, 10.5, 9, 2)} /><polygon points="13,8.6 17.5,6.2 17.5,13.8 13,11.4" />{slash}</>,
  screen: <><polygon points={crect(2.5, 3.5, 15, 10, 2)} /><polyline points="7,17 13,17" /><polyline points="10,13.5 10,17" /><polyline points="10,11 10,6.5" /><polyline points="7.8,8.7 10,6.5 12.2,8.7" /></>,
  hangup: <polygon className="f" points="2.5,11.2 4.6,8.2 15.4,8.2 17.5,11.2 17.5,13.2 14,13.2 13,11 7,11 6,13.2 2.5,13.2" />,
  plus: <><polyline points="10,4 10,16" /><polyline points="4,10 16,10" /></>,
  send: <><polyline points="5,15 15,5" /><polyline points="7.5,5 15,5 15,12.5" /></>,
  close: <><polyline points="5,5 15,15" /><polyline points="15,5 5,15" /></>,
  chevronLeft: <polyline points="12.5,4 6.5,10 12.5,16" />,
  chevronRight: <polyline points="7.5,4 13.5,10 7.5,16" />,
  chevronDown: <polyline points="4,7.5 10,13.5 16,7.5" />,
  arrowLeft: <><polyline points="16.5,10 3.5,10" /><polyline points="8.5,5 3.5,10 8.5,15" /></>,
  arrowUpRight: <><polyline points="5,15 15,5" /><polyline points="7.5,5 15,5 15,12.5" /></>,
  more: <><polygon className="f" points={diamond(4.5, 10, 1.5)} /><polygon className="f" points={diamond(10, 10, 1.5)} /><polygon className="f" points={diamond(15.5, 10, 1.5)} /></>,
  trash: <><polygon points="5,6 15,6 14,17 6,17" /><polyline points="3,6 17,6" /><polyline points="8,6 8,3.5 12,3.5 12,6" /><polyline points="8.6,9 8.9,14" /><polyline points="11.4,9 11.1,14" /></>,
  unsend: <><polyline points="7,4.5 3,8.5 7,12.5" /><polyline points="3,8.5 13,8.5 16.5,12 16.5,16" /><polyline points="9.5,13.5 12.5,16.5" /><polyline points="12.5,13.5 9.5,16.5" /></>,
  edit: <><polygon points="13,3 17,7 7.5,16.5 3,17 3.5,12.5" /><polyline points="11,5 15,9" /></>,
  play: <polygon className="f" points="6,3.8 16.5,10 6,16.2" />,
  pause: <><polygon className="f" points="5,4 8.5,4 8.5,16 5,16" /><polygon className="f" points="11.5,4 15,4 15,16 11.5,16" /></>,
  rewind: <><polygon className="f" points="10,5 3,10 10,15" /><polygon className="f" points="17,5 10,10 17,15" /></>,
  forward: <><polygon className="f" points="3,5 10,10 3,15" /><polygon className="f" points="10,5 17,10 10,15" /></>,
  skip: <><polygon className="f" points="3.5,4 12,10 3.5,16" /><polygon className="f" points="13.5,4 16,4 16,16 13.5,16" /></>,
  film: <><polygon points={crect(2.5, 3.5, 15, 13, 2)} /><polygon className="f" points="8.2,7 13.2,10 8.2,13" /></>,
  disc: <><polygon points={oct(9, 11, 6.5)} /><polygon className="f" points={diamond(9, 11, 1.8)} /><polyline points="14.5,2.5 17,5 13.4,9.8" /></>,
  vm: <><polygon points={crect(2.5, 3.5, 15, 10, 2)} /><polyline points="7,17 13,17" /><polyline points="10,13.5 10,17" /><polygon className="f" points="8,5.8 8,11.4 9.5,10.1 10.6,12.2 11.6,11.7 10.6,9.7 12.6,9.5" /></>,
  cursor: <polygon points="5,3 5,15.5 8.2,12.6 10.6,17 12.6,16 10.3,11.8 14.6,11.5" />,
  handoff: <><polygon points="3,3 3,13 5.6,10.7 7.5,14.2 9.1,13.4 7.3,10.1 10.7,9.8" /><polyline points="11.5,15.5 17,15.5" /><polyline points="14.5,13 17,15.5 14.5,18" /></>,
  bug: <><polygon points="7.2,6.2 12.8,6.2 14.5,8.2 14.5,14 12,17 8,17 5.5,14 5.5,8.2" /><polyline points="8,6.2 8.6,3.6 11.4,3.6 12,6.2" /><polyline points="10,8.5 10,17" /><polyline points="5.5,10 2.5,9" /><polyline points="5.5,13.5 2.5,15" /><polyline points="14.5,10 17.5,9" /><polyline points="14.5,13.5 17.5,15" /></>,
  bulb: <><polygon points="7,13 5,10 5,6 7.5,3 12.5,3 15,6 15,10 13,13" /><polyline points="7.5,15.5 12.5,15.5" /><polyline points="8.5,17.7 11.5,17.7" /></>,
  shield: <><polygon points="10,2.5 16.5,5 16.5,10 10,17.5 3.5,10 3.5,5" /><polyline points="7,9.8 9.2,12 13.2,7.6" /></>,
  bell: <><polygon points="10,3 13.5,4.5 14.5,8 14.5,12 16.5,14 3.5,14 5.5,12 5.5,8 6.5,4.5" /><polyline points="8.4,16.7 11.6,16.7" /></>,
  check: <polyline points="4,10.5 8,14.5 16,6" />,
  warn: <><polygon points="10,3 18,17 2,17" /><polyline points="10,8 10,12" /><polygon className="f" points={diamond(10, 14.4, 1)} /></>,
  offline: <><polyline points="2.5,8 5.6,5.4 14.4,5.4 17.5,8" /><polyline points="5.2,11 7.8,9 12.2,9 14.8,11" /><polyline points="8,14 10,12.5 12,14" />{slash}</>,
  key: <><polygon points={oct(6.5, 10, 3.6)} /><polyline points="10.1,10 17.5,10" /><polyline points="14,10 14,13" /><polyline points="16.6,10 16.6,12.4" /></>,
  link: <><polyline points="9,6.5 11,4.5 13,4.5 15.5,7 15.5,9 13.5,11" /><polyline points="11,13.5 9,15.5 7,15.5 4.5,13 4.5,11 6.5,9" /><polyline points="8,12 12,8" /></>,
  upload: <><polyline points="10,13 10,3.5" /><polyline points="6,7.5 10,3.5 14,7.5" /><polyline points="3.5,11.5 3.5,16.5 16.5,16.5 16.5,11.5" /></>,
  download: <><polyline points="10,3.5 10,13" /><polyline points="6,9 10,13 14,9" /><polyline points="3.5,11.5 3.5,16.5 16.5,16.5 16.5,11.5" /></>,
  copy: <><polygon points={crect(7, 7, 10, 10, 2)} /><polyline points="13,4.5 13,3 3,3 3,13 4.5,13" /></>,
  subtitles: <><polygon points={crect(2.5, 4, 15, 12, 2)} /><polyline points="5.5,10.5 9,10.5" /><polyline points="11,10.5 14.5,10.5" /><polyline points="5.5,13 12,13" /></>,
  queue: <><polyline points="7.5,5 17,5" /><polyline points="7.5,10 17,10" /><polyline points="7.5,15 13,15" /><polygon className="f" points={diamond(3.8, 5, 1.3)} /><polygon className="f" points={diamond(3.8, 10, 1.3)} /><polygon className="f" points={diamond(3.8, 15, 1.3)} /></>,
  lock: <><polygon points={crect(4, 9, 12, 8.5, 2)} /><polyline points="6.5,9 6.5,6 8.5,3.5 11.5,3.5 13.5,6 13.5,9" /></>,
  chat: <polygon points="3,4 15,4 17,6 17,12 15,14 9,14 5.5,17 5.5,14 3,14" />,
  reset: <><polyline points="16,12.5 13.5,16 6.5,16 4,13.5 4,6.5 6.5,4 13.5,4 16,6.5" /><polyline points="16,3 16,6.8 12.2,6.8" /></>,
  note: <><polyline points="8,15 8,4 16,2.8 16,13" /><polygon className="f" points="4.5,13.5 8,13.5 8,16.5 4.5,16.5" /><polygon className="f" points="12.5,12 16,12 16,15 12.5,15" /></>,
  signal: <><polygon className="f" points="3,13 6,13 6,16 3,16" /><polygon className="f" points="8.5,9 11.5,9 11.5,16 8.5,16" /><polygon className="f" points="14,4.5 17,4.5 17,16 14,16" /></>,
  expand: <><polyline points="3,8 3,3 8,3" /><polyline points="12,3 17,3 17,8" /><polyline points="17,12 17,17 12,17" /><polyline points="8,17 3,17 3,12" /></>,
  collapse: <><polyline points="8,3 8,8 3,8" /><polyline points="17,8 12,8 12,3" /><polyline points="12,17 12,12 17,12" /><polyline points="3,12 8,12 8,17" /></>,
  logout: <><polyline points="12,3.5 4,3.5 4,16.5 12,16.5" /><polyline points="8.5,10 17,10" /><polyline points="13.5,6.5 17,10 13.5,13.5" /></>,
  flag: <><polyline points="4.5,17.5 4.5,3" /><polygon points="4.5,3.5 15.5,3.5 13,7.5 15.5,11.5 4.5,11.5" /></>,
  film2: <><polygon points={crect(3, 3, 14, 14, 2)} /><polyline points="7,3 7,17" /><polyline points="13,3 13,17" /></>,
  volume: <><polygon points="3,7.5 6.2,7.5 10.5,4 10.5,16 6.2,12.5 3,12.5" /><polyline points="13.5,7 15,8.5 15,11.5 13.5,13" /></>,
  sparkle: <polygon points="10,2.5 11.6,8.4 17.5,10 11.6,11.6 10,17.5 8.4,11.6 2.5,10 8.4,8.4" />,
  inbox: <><polygon points={crect(2.5, 3.5, 15, 13, 2)} /><polyline points="2.5,11 6.5,11 8,13 12,13 13.5,11 17.5,11" /></>,
  user: <><polygon points={oct(10, 6.5, 3.2)} /><polyline points="3.5,17 3.5,14.6 6,12 14,12 16.5,14.6 16.5,17" /></>,
  diamond: <polygon className="f" points={diamond(10, 10, 3.2)} />,
  globe: <><polygon points={oct(10, 10, 7)} /><polyline points="3,10 17,10" /><polygon points="10,3 12.6,6.5 12.6,13.5 10,17 7.4,13.5 7.4,6.5" /></>,
  fingerprint: <><polyline points="5,15 5,8 7.5,4.5 12.5,4.5 15,8 15,11" /><polyline points="8,16 8,9 9.2,7.6 10.8,7.6 12,9 12,15.5" /><polyline points="10,10.5 10,17" /><polyline points="15,13.5 15,16" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof iconPaths;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Accessible label. Without it the icon is decorative (aria-hidden). */
  label?: string;
}

export function Icon({ name, size = 20, label, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className={`cc-icon${className ? ' ' + className : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {iconPaths[name]}
    </svg>
  );
}

/** The house mark: a little obelisk with a brass jewel fill in the pyramidion. */
export function ObeliskMark({ size = 22, lit = true, title }: { size?: number; lit?: boolean; title?: string }) {
  const id = 'ccob' + size + (lit ? 'l' : 'd');
  return (
    <svg viewBox="0 0 24 32" width={size * 0.75} height={size} className="cc-mark" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--cc-light)" />
          <stop offset="0.55" stopColor="var(--cc-accent)" />
          <stop offset="1" stopColor="var(--cc-stone-lit)" />
        </linearGradient>
      </defs>
      <polygon points="12,1 15,5.5 9,5.5" fill={lit ? `url(#${id})` : 'var(--cc-ink-3)'} />
      <polygon points="9,6.6 15,6.6 16,27 8,27" fill="var(--cc-ink)" opacity="0.92" />
      <polygon points="12,6.6 15,6.6 16,27 12,27" fill="var(--cc-ink)" opacity="0.18" />
      <polygon points="5,28.4 19,28.4 20.5,31 3.5,31" fill="var(--cc-ink)" opacity="0.92" />
    </svg>
  );
}
