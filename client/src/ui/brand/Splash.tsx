import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { copy } from "../copy";
import { prefersReducedMotion } from "../tokens/motion";
import { Logo } from "./Logo";

// Module lifetime is the app launch, independent of sign-outs and server changes.
let completed = false;

/** HC-040 section 13. Animation events finish motion; bounded timers also handle paused tabs. */
export function Splash({ ready, server }: { ready: boolean; server: string }) {
  const [done, setDone] = useState(completed);
  const [intro, setIntro] = useState(false);
  const [risen, setRisen] = useState(false);
  const [status, setStatus] = useState(0);
  const [out, setOut] = useState<"fly" | "fade">();
  const root = useRef<HTMLDivElement>(null);
  const started = useRef(performance.now());
  const finish = () => {
    completed = true;
    document.querySelector(".hc-shell")?.removeAttribute("data-enter");
    document.querySelector(".hc-root")?.removeAttribute("data-launch-waiting");
    setDone(true);
  };
  useEffect(() => {
    if (done) return;
    const grace = setTimeout(() => setIntro(true), Math.max(0, 300 - (performance.now() - started.current)));
    const rise = setTimeout(() => setRisen(true), Math.max(0, 620 - (performance.now() - started.current)));
    const line = setTimeout(() => setStatus(1), 4000);
    const slow = setTimeout(() => setStatus(2), 12000);
    return () => { clearTimeout(grace); clearTimeout(rise); clearTimeout(line); clearTimeout(slow); };
  }, [done]);
  useLayoutEffect(() => {
    if (done || out) return;
    if (!ready || (intro && !risen && !prefersReducedMotion())) {
      document.querySelector(".hc-root")?.setAttribute("data-launch-waiting", "");
      return;
    }
    document.querySelector(".hc-root")?.removeAttribute("data-launch-waiting");
    const shell = document.querySelector(".hc-shell");
    if (!intro) {
      // Fast start: no splash, and the real picker mark stays visible.
      if (!prefersReducedMotion()) shell?.setAttribute("data-enter-fast", "");
      completed = true;
      setDone(true);
      return;
    }
    const a = root.current?.querySelector(".hc-splash__mark")?.getBoundingClientRect();
    const b = shell?.querySelector(".hc-picker .hc-logo")?.getBoundingClientRect();
    const fly = !prefersReducedMotion() && a && b && b.width > 0 && b.right > 0 && b.left < innerWidth;
    if (fly && root.current) {
      root.current.style.setProperty("--hc-splash-dx", `${b.left + b.width / 2 - (a.left + a.width / 2)}px`);
      root.current.style.setProperty("--hc-splash-dy", `${b.top + b.height / 2 - (a.top + a.height / 2)}px`);
      root.current.style.setProperty("--hc-splash-s", String(b.width / a.width));
    }
    // Hide the destination in this same layout pass, before either mark paints.
    shell?.setAttribute("data-enter", "");
    setOut(fly ? "fly" : "fade");
  }, [ready, intro, risen, done, out]);
  useEffect(() => {
    if (!out) return;
    const timer = setTimeout(finish, out === "fly" ? 560 : 190);
    return () => clearTimeout(timer);
  }, [out]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => document.querySelector(".hc-shell")?.removeAttribute("data-enter-fast"), 380);
    return () => clearTimeout(timer);
  }, [done]);
  useEffect(() => () => {
    document.querySelector(".hc-root")?.removeAttribute("data-launch-waiting");
  }, []);
  if (done || !intro) return null;
  return <div ref={root} className="hc-splash" role="status" aria-label={copy.splash.label} data-intro="" data-out={out} data-testid="splash">
    <span className="hc-splash__mark" onAnimationEnd={event => { if (event.target === event.currentTarget && out) finish(); }}>
      <span className="hc-splash__rise" onAnimationEnd={event => { if (event.target === event.currentTarget) setRisen(true); }}><Logo label="" /></span>
      <svg className="hc-splash__spill" viewBox="0 29 32 14" aria-hidden="true">
        <defs><linearGradient id="hc-splash-spill" x1="0" y1="29" x2="0" y2="43" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="hc-splash__stop" stopOpacity="0.34" /><stop offset="0.45" className="hc-splash__stop" stopOpacity="0.1" /><stop offset="1" className="hc-splash__stop" stopOpacity="0" />
        </linearGradient></defs><path fill="url(#hc-splash-spill)" d="M12 29H20L27 43H5Z" />
      </svg>
    </span>
    {status > 0 && <p className="hc-splash__status">{status === 2 && server ? copy.splash.slow(server) : server ? copy.splash.status(server) : copy.splash.statusNoServer}</p>}
  </div>;
}
