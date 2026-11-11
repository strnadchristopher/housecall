/**
 * Housecall theme tokens. This is the ONE place theme values live.
 *
 * Every colour the UI paints comes from here and is exposed as a CSS custom
 * property (`--cc-<token>`) by `applyTheme`. Components never hard-code colour.
 *
 * Palette rules (see ~/Documents/UIDesignGuidelines.md):
 * - Accents are tonal, not poster-bright: a pale text tint plus a deep fill.
 * - No blue-slate dark, no purple, no cream, no UI-kit grey.
 * - Edges are self-coloured (the surface's own hue at low alpha), never a
 *   contrasting hairline.
 */

export type ThemeId = 'basalt' | 'moss' | 'oxblood' | 'cyanotype' | 'contrast';

export interface ThemeTokens {
  /** Substrate behind everything (window chrome, mobile background). */
  bg: string;
  /** Sidebar / navigation surface. */
  surface0: string;
  /** Main reading surface (conversation). */
  surface1: string;
  /** Raised: composer, popovers, cards. */
  surface2: string;
  /** Pressed / hovered / selected. */
  surface3: string;
  /** Self-coloured edge, felt more than seen. */
  edge: string;
  edgeStrong: string;
  /** Top-lip highlight used as an inset shadow on raised surfaces. */
  lip: string;
  ink: string;
  ink2: string;
  ink3: string;
  /** Tonal accent for text, marks and the obelisk marker. */
  accent: string;
  /** Deep accent surface for the primary action. */
  accentFill: string;
  /** Text on accentFill. */
  accentInk: string;
  /** Very low alpha wash: mention rows, own reactions, selection. */
  accentWash: string;
  ok: string;
  warn: string;
  danger: string;
  dangerFill: string;
  dangerInk: string;
  online: string;
  idle: string;
  dnd: string;
  /** Tint for tight directional shadows (never black bloom). */
  shadow: string;
  /** Grain opacity on the substrate only. */
  grain: string;
  /** Onboarding scene: sky top/bottom, ground, stone, lit stone, light. */
  skyTop: string;
  skyBottom: string;
  ground: string;
  stone: string;
  stoneLit: string;
  light: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  /** One short line shown in the theme picker. */
  note: string;
  scheme: 'dark' | 'light';
  tokens: ThemeTokens;
}

export const themes: Record<ThemeId, Theme> = {
  basalt: {
    id: 'basalt',
    name: 'Basalt',
    note: 'Warm stone, brass light. The default.',
    scheme: 'dark',
    tokens: {
      bg: '#0d0c0a',
      surface0: '#12110e',
      surface1: '#171612',
      surface2: '#1f1d19',
      surface3: '#2a2722',
      edge: 'rgba(240, 228, 204, 0.075)',
      edgeStrong: 'rgba(240, 228, 204, 0.15)',
      lip: 'rgba(255, 244, 222, 0.055)',
      ink: '#ede8dc',
      ink2: '#bdb6a6',
      ink3: '#8a8475',
      accent: '#d9bf8a',
      accentFill: '#5a4829',
      accentInk: '#fbeccb',
      accentWash: 'rgba(217, 191, 138, 0.085)',
      ok: '#a3c79e',
      warn: '#e2b56b',
      danger: '#e8957f',
      dangerFill: '#41211a',
      dangerInk: '#ffd2c4',
      online: '#93c78c',
      idle: '#d9b26a',
      dnd: '#e2806c',
      shadow: 'rgba(4, 3, 1, 0.55)',
      grain: '0.05',
      skyTop: '#0b0a09',
      skyBottom: '#2b2116',
      ground: '#100e0b',
      stone: '#26221c',
      stoneLit: '#c9a86c',
      light: '#f4d79b',
    },
  },
  moss: {
    id: 'moss',
    name: 'Moss',
    note: 'Green-black, lichen highlights.',
    scheme: 'dark',
    tokens: {
      bg: '#090d0a',
      surface0: '#0c110e',
      surface1: '#101612',
      surface2: '#161e18',
      surface3: '#1f2921',
      edge: 'rgba(214, 236, 214, 0.07)',
      edgeStrong: 'rgba(214, 236, 214, 0.14)',
      lip: 'rgba(226, 246, 226, 0.05)',
      ink: '#e2ebe2',
      ink2: '#a7b6aa',
      ink3: '#728475',
      accent: '#c8da92',
      accentFill: '#3b4922',
      accentInk: '#eef6cf',
      accentWash: 'rgba(200, 218, 146, 0.08)',
      ok: '#a6d39b',
      warn: '#dcc074',
      danger: '#e59a86',
      dangerFill: '#3a1f19',
      dangerInk: '#ffd5c9',
      online: '#a6d39b',
      idle: '#dcc074',
      dnd: '#e2846f',
      shadow: 'rgba(0, 4, 1, 0.55)',
      grain: '0.05',
      skyTop: '#070a08',
      skyBottom: '#17251a',
      ground: '#0a0f0b',
      stone: '#1b241d',
      stoneLit: '#b2c77a',
      light: '#e3f0b4',
    },
  },
  oxblood: {
    id: 'oxblood',
    name: 'Oxblood',
    note: 'Red-black lacquer, rose-bone type.',
    scheme: 'dark',
    tokens: {
      bg: '#100909',
      surface0: '#150c0c',
      surface1: '#1a0f0f',
      surface2: '#231514',
      surface3: '#2f1d1b',
      edge: 'rgba(250, 214, 204, 0.075)',
      edgeStrong: 'rgba(250, 214, 204, 0.15)',
      lip: 'rgba(255, 226, 218, 0.055)',
      ink: '#f3e7e3',
      ink2: '#c8afa8',
      ink3: '#977c75',
      accent: '#ecb3a2',
      accentFill: '#6a2d23',
      accentInk: '#ffe4da',
      accentWash: 'rgba(236, 179, 162, 0.085)',
      ok: '#b4c99a',
      warn: '#e6bb78',
      danger: '#ff9c85',
      dangerFill: '#4f1d16',
      dangerInk: '#ffd9cf',
      online: '#b4c99a',
      idle: '#e6bb78',
      dnd: '#ff8d74',
      shadow: 'rgba(6, 0, 0, 0.55)',
      grain: '0.05',
      skyTop: '#0e0707',
      skyBottom: '#33140f',
      ground: '#120a09',
      stone: '#2a1816',
      stoneLit: '#d48f78',
      light: '#ffc9b1',
    },
  },
  cyanotype: {
    id: 'cyanotype',
    name: 'Cyanotype',
    note: 'Prussian ink on sun-printed paper.',
    scheme: 'light',
    tokens: {
      bg: '#c3d8e0',
      surface0: '#cfe1e8',
      surface1: '#e2eef2',
      surface2: '#f0f6f8',
      surface3: '#c7dbe3',
      edge: 'rgba(16, 52, 78, 0.10)',
      edgeStrong: 'rgba(16, 52, 78, 0.2)',
      lip: 'rgba(255, 255, 255, 0.6)',
      ink: '#0c2a3e',
      ink2: '#2f5269',
      ink3: '#405e73',
      accent: '#164c75',
      accentFill: '#164c75',
      accentInk: '#eef7fb',
      accentWash: 'rgba(22, 76, 117, 0.09)',
      ok: '#2d6b45',
      warn: '#8a5a12',
      danger: '#983224',
      dangerFill: '#983224',
      dangerInk: '#fff1ec',
      online: '#2f7a4c',
      idle: '#a26d16',
      dnd: '#b8432f',
      shadow: 'rgba(12, 42, 62, 0.18)',
      grain: '0.06',
      skyTop: '#9fc1cf',
      skyBottom: '#e3eff3',
      ground: '#b6d0da',
      stone: '#1b4a6c',
      stoneLit: '#eaf5f9',
      light: '#ffffff',
    },
  },
  contrast: {
    id: 'contrast',
    name: 'Contrast',
    note: 'Maximum legibility. Black, white, signal yellow.',
    scheme: 'dark',
    tokens: {
      bg: '#000000',
      surface0: '#000000',
      surface1: '#0a0a0a',
      surface2: '#161616',
      surface3: '#2a2a2a',
      edge: 'rgba(255, 255, 255, 0.3)',
      edgeStrong: 'rgba(255, 255, 255, 0.6)',
      lip: 'rgba(255, 255, 255, 0)',
      ink: '#ffffff',
      ink2: '#ededed',
      ink3: '#c4c4c4',
      accent: '#ffd60a',
      accentFill: '#ffd60a',
      accentInk: '#000000',
      accentWash: 'rgba(255, 214, 10, 0.16)',
      ok: '#7dff9b',
      warn: '#ffd60a',
      danger: '#ff7a66',
      dangerFill: '#ff7a66',
      dangerInk: '#000000',
      online: '#7dff9b',
      idle: '#ffd60a',
      dnd: '#ff7a66',
      shadow: 'rgba(0, 0, 0, 0)',
      grain: '0',
      skyTop: '#000000',
      skyBottom: '#1c1c1c',
      ground: '#000000',
      stone: '#2e2e2e',
      stoneLit: '#ffd60a',
      light: '#ffffff',
    },
  },
};

export const themeOrder: ThemeId[] = ['basalt', 'moss', 'oxblood', 'cyanotype', 'contrast'];
export const defaultThemeId: ThemeId = 'basalt';

/** Non-colour tokens shared by every theme. */
export const scale = {
  fontDisplay: "'Gambarino', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  fontBody: "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', sans-serif",
  /** Mono is for genuine data only: code spans and byte counts. */
  fontMono: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace",
  radiusS: '6px',
  radiusM: '10px',
  radiusL: '16px',
  /** The house silhouette: one corner cut like a dressed stone. */
  cut: '9px',
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  durFast: '120ms',
  dur: '220ms',
  durSlow: '420ms',
} as const;

function kebab(key: string) {
  return key.replace(/[A-Z0-9]/g, m => '-' + m.toLowerCase()).replace(/^-/, '');
}

/** CSS custom properties for a theme, e.g. `--cc-surface-1`. */
export function themeVars(id: ThemeId): Record<string, string> {
  const theme = themes[id] ?? themes[defaultThemeId];
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.tokens)) vars[`--cc-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(scale)) vars[`--cc-${kebab(key)}`] = value;
  return vars;
}

/** Apply a theme to an element (defaults to <html>). Synchronous, no flash. */
export function applyTheme(id: ThemeId, el: HTMLElement = document.documentElement) {
  const theme = themes[id] ?? themes[defaultThemeId];
  for (const [name, value] of Object.entries(themeVars(theme.id))) el.style.setProperty(name, value);
  el.dataset.ccTheme = theme.id;
  el.dataset.ccScheme = theme.scheme;
  el.style.colorScheme = theme.scheme;
}
