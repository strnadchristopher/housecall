import { useEffect, useRef, useState } from "react";
import type { UpdateState } from "../../core/identity";
import type { Updater } from "./identity";

// Signed self-update for the desktop app. Checks on launch and every
// 30 minutes, downloads in the background, then offers a restart.
const CHECK_EVERY_MS = 30 * 60 * 1000;

function isDesktop() {
  return "__TAURI_INTERNALS__" in window && !/android|iphone|ipad/i.test(navigator.userAgent);
}

export function useDesktopUpdater(): Updater {
  const [state, setState] = useState<UpdateState>();
  const [hidden, setHidden] = useState(false);
  const install = useRef<(() => Promise<void>) | undefined>(undefined);
  const downloaded = useRef(false);

  useEffect(() => {
    if (!isDesktop()) return;
    let stopped = false;
    let busy = false;
    const run = async () => {
      if (busy || stopped || downloaded.current) return;
      busy = true;
      let version = "";
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update || stopped) return;
        version = update.version;
        setHidden(false);
        setState({ kind: "downloading", version });
        let total = 0;
        let got = 0;
        await update.download(event => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress" && total > 0) {
            got += event.data.chunkLength;
            setState({ kind: "downloading", version, percent: Math.min(99, Math.round((got / total) * 100)) });
          }
        });
        if (stopped) return;
        downloaded.current = true;
        install.current = async () => {
          await update.install();
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        };
        setState({ kind: "ready", version });
      } catch (error) {
        console.warn("Housecall update check failed", error);
        if (version) setState({ kind: "failed", version });
      } finally {
        busy = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), CHECK_EVERY_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  return {
    state: hidden ? undefined : state,
    dismiss: () => setHidden(true),
    restart: async () => {
      if (state?.kind !== "ready" || !install.current) return;
      const version = state.version;
      setState({ kind: "installing", version });
      try { await install.current(); } catch (error) {
        console.warn("Housecall update install failed", error);
        downloaded.current = false;
        setState({ kind: "failed", version });
      }
    },
  };
}
