import { useSyncExternalStore } from 'react';
import type { ScreenId } from '../contracts/ui';
import { applyTheme, defaultThemeId, themes, type ThemeId } from './tokens/themes';

/**
 * Presentation-only state shared between sibling Screens that App.tsx renders
 * next to each other (shell + content). Nothing here is data, auth or
 * transport: just which view is on screen, the visible channel title,
 * whether the phone drawer is open, the chosen theme, and how many live call
 * streams exist (for the call dock).
 */
export interface UiState {
  view?: ScreenId;
  channelTitle?: string;
  /** Signed-in username, read from the shell title. */
  me?: string;
  drawer: boolean;
  theme: ThemeId;
  streams: number;
}

const THEME_KEY = 'housecall.theme';

function storedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (v && v in themes) return v;
  } catch { /* storage blocked: fall back */ }
  return defaultThemeId;
}

let state: UiState = { drawer: false, theme: typeof window === 'undefined' ? defaultThemeId : storedTheme(), streams: 0 };
const listeners = new Set<() => void>();

export function getUi() { return state; }

export function setUi(patch: Partial<UiState>) {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof UiState)[]) if (state[k] !== patch[k]) changed = true;
  if (!changed) return;
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useUi<T>(pick: (s: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state), () => pick(state));
}

export function setTheme(id: ThemeId) {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* not persisted, still applied */ }
  applyTheme(id);
  setUi({ theme: id });
}

/** Called once when the UI module loads: theme, root class, platform. */
export function bootUi() {
  if (typeof document === 'undefined') return;
  applyTheme(state.theme);
  const root = document.getElementById('root') ?? document.body;
  root.classList.add('cc-root');
  const ua = navigator.userAgent;
  root.dataset.platform = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  const sync = () => { meta!.content = themes[state.theme].tokens.surface0; };
  sync();
  subscribe(sync);
  watchStreams(root);
}

/** Count App's remote call media elements so the shell can show a call dock. */
function watchStreams(root: HTMLElement) {
  const count = () => setUi({ streams: root.querySelectorAll('[data-testid="remote-media"]').length });
  new MutationObserver(count).observe(root, { childList: true, subtree: true });
  count();
}
