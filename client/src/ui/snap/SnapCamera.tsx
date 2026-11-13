import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../copy";
import { Button, Icon, cx } from "../kit";

export type CameraFacing = "user" | "environment";

/** True when this browser can open a camera at all. Without it callers use the file input. */
export const cameraSupported = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

type Torchable = MediaTrackCapabilities & { torch?: boolean };

/**
 * Opens a camera and keeps it open for as long as the component lives. The rear camera is the first
 * choice, so a phone starts on it and a desktop uses the only camera it has. `retry()` asks again
 * after a refusal; `flip()` switches between front and rear.
 */
export function useCameraStream() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>("environment");
  const [front, setFront] = useState(false);
  const [state, setState] = useState<"starting" | "live" | "blocked">("starting");
  const [multiple, setMultiple] = useState(false);
  const [torchable, setTorchable] = useState(false);
  const [torch, setTorch] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("starting"); setTorch(false); setTorchable(false);
    (async () => {
      try {
        const next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false,
        });
        if (!alive) { next.getTracks().forEach(track => track.stop()); return; }
        stream.current?.getTracks().forEach(track => track.stop());
        stream.current = next;
        const track = next.getVideoTracks()[0];
        setFront(track?.getSettings().facingMode === "user");
        setTorchable(!!(track?.getCapabilities?.() as Torchable | undefined)?.torch);
        const element = video.current;
        if (element) { element.srcObject = next; void element.play().catch(() => {}); }
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (alive) { setMultiple(devices.filter(device => device.kind === "videoinput").length > 1); setState("live"); }
      } catch {
        if (alive) setState("blocked");
      }
    })();
    return () => { alive = false; };
  }, [facing, attempt]);

  useEffect(() => () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; }, []);

  const toggleTorch = useCallback(async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch(next);
    } catch { setTorchable(false); }
  }, [torch]);

  return {
    video, state, front, multiple, torchable, torch, toggleTorch,
    flip: () => setFacing(current => (current === "user" ? "environment" : "user")),
    retry: () => setAttempt(count => count + 1),
    /** The current frame as a JPEG at the track's native resolution, not mirrored. */
    async still(): Promise<File | undefined> {
      const element = video.current;
      if (!element || !element.videoWidth) return undefined;
      const canvas = document.createElement("canvas");
      canvas.width = element.videoWidth; canvas.height = element.videoHeight;
      canvas.getContext("2d")?.drawImage(element, 0, 0);
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/jpeg", 0.92));
      return blob ? new File([blob], "snap.jpg", { type: "image/jpeg" }) : undefined;
    },
  };
}

/** Keeps Tab inside the layer, handles Escape, and hands focus back when the layer goes. */
function useLayerFocus(root: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); latest.current(); return; }
      if (event.key !== "Tab" || !root.current) return;
      const items = [...root.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!root.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, [root]);
}

export interface SnapCameraProps {
  /** "photo" takes a snap; "scan" is the QR finder (no shutter, gallery or flip). */
  mode?: "photo" | "scan";
  onClose: () => void;
  /** Photo mode: send the picture. Resolves true when it went, and the layer then closes. */
  onSend?: (photo: File) => Promise<boolean>;
  /** Shown over the review actions after a failed send. */
  error?: string;
  /** Scan mode: called with the live video at most 8 times a second. */
  onFrame?: (video: HTMLVideoElement) => void;
  /** Scan mode: the finder shows the found state. */
  found?: boolean;
  /** Scan mode: a line that replaces the second hint line, in the danger colour. */
  wrong?: string;
}

/**
 * Full-screen camera, always dark. One component for two jobs: photo (shutter, review, send) and
 * scan (a finder and a hint; the caller decodes frames). The preview and stream hook are exported
 * so the QR login flow mounts exactly this.
 */
export function SnapCamera({ mode = "photo", onClose, onSend, error, onFrame, found, wrong }: SnapCameraProps) {
  const camera = useCameraStream();
  const root = useRef<HTMLDivElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const scan = mode === "scan";
  const [photo, setPhoto] = useState<File>();
  const [shot, setShot] = useState<string>();
  const [blink, setBlink] = useState(false);
  const [fill, setFill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const review = !!photo;

  useEffect(() => {
    if (!photo) { setShot(undefined); return; }
    const url = URL.createObjectURL(photo);
    setShot(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useLayerFocus(root, () => { if (busy) return; if (review) setPhoto(undefined); else onClose(); });
  useEffect(() => { root.current?.querySelector<HTMLElement>(".hc-cam__shutter, .hc-cam__btn")?.focus(); }, []);

  // Scan mode: sample frames at most eight times a second.
  const frame = useRef(onFrame);
  frame.current = onFrame;
  useEffect(() => {
    if (!scan || camera.state !== "live") return;
    const timer = setInterval(() => { const element = camera.video.current; if (element?.videoWidth) frame.current?.(element); }, 125);
    return () => clearInterval(timer);
  }, [scan, camera.state, camera.video]);

  const capture = async () => {
    if (review || busy) return;
    setBlink(true); setTimeout(() => setBlink(false), 190);
    if (camera.front) { setFill(true); setTimeout(() => setFill(false), 240); }
    const file = await camera.still();
    if (file) { setFailed(false); setPhoto(file); }
  };

  const send = async () => {
    if (!photo || !onSend || busy) return;
    setBusy(true); setFailed(false);
    const ok = await onSend(photo).catch(() => false);
    setBusy(false);
    if (ok) onClose(); else setFailed(true);
  };

  const blocked = camera.state === "blocked" && !review;
  return (
    <div ref={root} className={cx("hc-cam hc-anim-fade", review && "is-review", scan && "hc-cam--scan")} role="dialog" aria-modal="true" aria-label={copy.camera.label} data-testid="snap-camera">
      <video ref={camera.video} className={cx("hc-cam__view", camera.front && "is-front")} hidden={review} autoPlay playsInline muted data-testid="snap-camera-video" />
      {review && <img className="hc-cam__view" src={shot} alt={copy.camera.yourPhoto} draggable={false} data-testid="snap-camera-still" />}
      <span className="hc-cam__shade hc-cam__shade--top" />
      <span className="hc-cam__shade hc-cam__shade--bottom" />
      <span className={cx("hc-cam__blink", blink && "is-on")} />
      <span className={cx("hc-cam__fill", fill && "is-on")} />

      {scan && !blocked && (
        <>
          <div className={cx("hc-cam__finder", found && "is-found")}>
            <svg className="hc-cam__corners" viewBox="0 0 100 100" aria-hidden="true">
              <path vectorEffect="non-scaling-stroke" d="M2 24V13A11 11 0 0 1 13 2H24M76 2H87A11 11 0 0 1 98 13V24M98 76V87A11 11 0 0 1 87 98H76M24 98H13A11 11 0 0 1 2 87V76" />
            </svg>
          </div>
          <p className="hc-cam__hint" role="status">
            {found ? copy.camera.scanFound : copy.camera.scanHint}
            {!found && <small className={wrong ? "is-error" : undefined}>{wrong || copy.camera.scanWhere}</small>}
          </p>
        </>
      )}

      <div className="hc-cam__top">
        <button type="button" className="hc-cam__btn" aria-label={copy.camera.close} onClick={onClose} disabled={busy}><Icon name="close" /></button>
        {scan && <span className="hc-cam__title">{copy.camera.scanTitle}</span>}
        {!review && !blocked && camera.torchable
          ? <button type="button" className={cx("hc-cam__btn", camera.torch && "is-lit")} aria-pressed={camera.torch}
              aria-label={scan ? (camera.torch ? copy.camera.lightOff : copy.camera.lightOn) : (camera.torch ? copy.camera.flashOff : copy.camera.flashOn)}
              onClick={() => void camera.toggleTorch()}><Icon name="flash" off={!camera.torch} /></button>
          : <span className="hc-cam__spacer" />}
      </div>

      {blocked && (
        <div className="hc-cam__blocked" data-testid="snap-camera-blocked">
          <Icon name="camera" off />
          <strong>{copy.camera.blockedTitle}</strong>
          <p>{copy.camera.blockedBody}</p>
          <Button kind="primary" onClick={camera.retry}>{copy.camera.tryAgain}</Button>
          {!scan && <Button kind="text" onClick={() => gallery.current?.click()}>{copy.camera.galleryInstead}</Button>}
        </div>
      )}

      {!scan && !blocked && !review && (
        <div className="hc-cam__bottom">
          <button type="button" className="hc-cam__btn" aria-label={copy.camera.gallery} onClick={() => gallery.current?.click()}><Icon name="image" /></button>
          <button type="button" className="hc-cam__shutter" aria-label={copy.camera.take} disabled={camera.state !== "live"} onClick={() => void capture()} />
          {camera.multiple
            ? <button type="button" className="hc-cam__btn" aria-label={copy.camera.flip} onClick={camera.flip}><Icon name="flip" /></button>
            : <span className="hc-cam__spacer" />}
        </div>
      )}

      {review && (
        <div className="hc-cam__bottom">
          <span className="hc-cam__once" role={failed ? "alert" : undefined}><Icon name="eye" />{failed && error ? error : copy.snaps.once}</span>
          <button type="button" className="hc-cam__btn" onClick={() => setPhoto(undefined)} disabled={busy}><Icon name="retry" />{copy.camera.retake}</button>
          <Button kind="primary" className="hc-cam__send" onClick={() => void send()} busy={busy}>
            {busy ? copy.snaps.sending : <>{copy.camera.send}<Icon name="send" /></>}
          </Button>
        </div>
      )}

      {!scan && (
        <input ref={gallery} type="file" accept="image/*" className="hc-sr" tabIndex={-1} aria-hidden="true" data-testid="snap-camera-gallery"
          onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) setPhoto(chosen); }} />
      )}
    </div>
  );
}
