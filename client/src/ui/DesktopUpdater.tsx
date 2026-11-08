import { useEffect, useRef, useState } from "react";
import { Banner, Button } from "./primitives";

// Signed self-update for the desktop app. Checks on launch and every
// 30 minutes, downloads in the background, then offers a one-click restart.
const CHECK_EVERY_MS = 30 * 60 * 1000;

type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "ready"; version: string; install: () => Promise<void> }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string };

function isDesktop() {
  return "__TAURI_INTERNALS__" in window && !/android|iphone|ipad/i.test(navigator.userAgent);
}

export function DesktopUpdater() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hidden, setHidden] = useState(false);
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
        setPhase({ kind: "downloading", version });
        let total = 0;
        let got = 0;
        await update.download(event => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress" && total > 0) {
            got += event.data.chunkLength;
            setPhase({ kind: "downloading", version, percent: Math.min(99, Math.round((got / total) * 100)) });
          }
        });
        if (stopped) return;
        downloaded.current = true;
        setPhase({
          kind: "ready",
          version,
          install: async () => {
            await update.install();
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          },
        });
      } catch (error) {
        console.warn("Chriscord update check failed", error);
        if (version) setPhase({ kind: "failed", version });
      } finally {
        busy = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), CHECK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  if (phase.kind === "idle" || hidden) return null;

  const restart = async () => {
    if (phase.kind !== "ready") return;
    const { install, version } = phase;
    setPhase({ kind: "installing", version });
    try {
      await install();
    } catch (error) {
      console.warn("Chriscord update install failed", error);
      downloaded.current = false;
      setPhase({ kind: "failed", version });
    }
  };

  return (
    <div className="cc-updater">
      {phase.kind === "downloading" && (
        <Banner icon="download">
          <strong>Chriscord {phase.version}</strong> is available. Downloading
          {phase.percent === undefined ? "…" : ` ${phase.percent}%`}
        </Banner>
      )}
      {(phase.kind === "ready" || phase.kind === "installing") && (
        <Banner
          tone="ok"
          icon="check"
          action={
            <span className="cc-updater__actions">
              {phase.kind === "ready" && (
                <Button variant="quiet" onClick={() => setHidden(true)}>Later</Button>
              )}
              <Button variant="primary" busy={phase.kind === "installing"} onClick={() => void restart()}>
                Restart
              </Button>
            </span>
          }
        >
          <strong>Chriscord {phase.version}</strong> is ready to install.
        </Banner>
      )}
      {phase.kind === "failed" && (
        <Banner
          tone="warn"
          icon="warn"
          action={<Button variant="quiet" onClick={() => setHidden(true)}>Dismiss</Button>}
        >
          Couldn't update to <strong>Chriscord {phase.version}</strong>. Trying again later.
        </Banner>
      )}
    </div>
  );
}
