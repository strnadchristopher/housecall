import { useEffect, useRef, useState } from 'react';
import { copy } from '../copy';
// Native source is compiled/verified separately. A rejected bridge never enables the QR reveal.
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export function useSensitiveSurface(active: boolean, onCapture: () => void) {
  const callback = useRef(onCapture); callback.current = onCapture;
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!active) { setReady(false); return; }
    const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
    if (!invoke) { setError(copy.link.useApp); return; }
    let alive = true, busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const result = await invoke<{ ok: boolean; captured: boolean }>('plugin:secure-session|sensitive_surface', { enabled: true });
        if (!alive) return;
        if (!result.ok || result.captured) { setReady(false); callback.current(); } else setReady(true);
      } catch { if (alive) { setReady(false); setError(copy.security.surfaceUnavailable); callback.current(); } }
      finally { busy = false; }
    };
    const release = () => { void invoke('plugin:secure-session|sensitive_surface', { enabled: false }).catch(() => {}); };
    window.addEventListener('pagehide', release);
    void tick(); const timer = setInterval(() => { void tick(); }, 250);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('pagehide', release); release(); };
  }, [active]);
  return { ready, error };
}

/** A WebView reload can bypass React cleanup. Clear the previous page's scoped flag on cold boot. */
export function resetSensitiveSurface() {
  const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
  if (invoke) void invoke('plugin:secure-session|sensitive_surface', { enabled: false }).catch(() => {});
}
