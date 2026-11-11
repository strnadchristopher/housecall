import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useCall, useIdentity } from "../../core/context";
import type { SetupRow } from "../../core/identity";
import { acquireMedia } from "../../transport/voice";
import { copy } from "../copy";
import { Button, ErrorLine, Icon, cx } from "../kit";
import { ALL_CARDS, INTEGRATIONS, type IntegrationId, type Step } from "./steps";

const SEGMENTS = 14;

/** Microphone level and camera preview, through the same acquireMedia a call uses. Nothing is sent anywhere. */
function DeviceTest() {
  const call = useCall();
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [lit, setLit] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const stopAll = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    stopAll.current();
    stopAll.current = () => {};
    setOn(false);
    setLit(0);
  }, []);
  useEffect(() => stop, [stop]);

  const start = async () => {
    setProblem(""); setNote("");
    try {
      const got = await acquireMedia({ echoCancellation: true }, { width: { ideal: 640 }, height: { ideal: 360 } }, call.selected);
      if (!got.camera) setNote(copy.setup.noCamera);
      stream.current = got.stream;
      const context = new AudioContext();
      const source = context.createMediaStreamSource(new MediaStream(got.stream.getAudioTracks()));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let frame = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
        setLit(Math.min(SEGMENTS, Math.round((peak / 128) * SEGMENTS * 2.2)));
        frame = requestAnimationFrame(tick);
      };
      tick();
      stopAll.current = () => {
        cancelAnimationFrame(frame);
        for (const track of got.stream.getTracks()) track.stop();
        void context.close();
        stream.current = undefined;
      };
      setOn(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    if (on && video.current && stream.current) video.current.srcObject = stream.current;
  }, [on]);

  return (
    <div className="hc-devtest" data-testid="device-test">
      <Button onClick={() => (on ? stop() : void start())}>{on ? copy.setup.stopTest : copy.setup.test}</Button>
      {on && (
        <>
          <div className="hc-meter" role="meter" aria-label={copy.setup.micLevel} aria-valuemin={0} aria-valuemax={SEGMENTS} aria-valuenow={lit} data-testid="mic-meter">
            {Array.from({ length: SEGMENTS }, (_, index) => <i key={index} data-on={index < lit ? "" : undefined} />)}
          </div>
          <video ref={video} className="hc-devtest__video" autoPlay muted playsInline aria-label={copy.setup.cameraPreview} data-testid="camera-preview" />
        </>
      )}
      {note && <p className="hc-muted">{note}</p>}
      <ErrorLine text={problem} />
    </div>
  );
}

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const label = code.split("\n")[0].split("=")[0].trim() || copy.common.copy;
  const copyIt = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  return (
    <div className="hc-snippet">
      <pre><code>{code}</code></pre>
      <Button kind="text" aria-label={copy.setup.copy(label)} onClick={() => void copyIt()}>{copied ? copy.common.copied : copy.common.copy}</Button>
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="hc-steps">
      {steps.map((step, index) => (
        <li key={index}>{typeof step === "string" ? step : <Snippet code={step.code} />}</li>
      ))}
    </ol>
  );
}

function Card({ id, row, open, onToggle, onCheck, checking }: {
  id: IntegrationId; row?: SetupRow; open: boolean; onToggle: () => void; onCheck: () => void; checking: boolean;
}) {
  const info = INTEGRATIONS[id];
  const panel = useId();
  const state = !row ? copy.setup.checking : row.ready ? copy.setup.ready : copy.setup.needsSetup;
  return (
    <li className="hc-card-int" data-state={!row ? "pending" : row.ready ? "ready" : "todo"} data-testid={`integration-${id}`}>
      <button type="button" className="hc-card-int__head" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <span className="hc-card-int__text"><strong>{info.title}</strong><small>{info.why}</small></span>
        <span className="hc-card-int__state">{row?.ready && <Icon name="check" />}{state}</span>
        <span className={cx("hc-card-int__chev", open && "is-open")}><Icon name="down" /></span>
      </button>
      {open && (
        <div id={panel} className="hc-card-int__body">
          {row && !row.ready && row.missing && row.missing.length > 0 && <p className="hc-muted">{copy.setup.missing}: {row.missing.join(", ")}</p>}
          {row?.detail && <p className="hc-muted">{row.detail}</p>}
          <Steps steps={info.steps} />
          {id === "calls" && <DeviceTest />}
          <div className="hc-inline">
            <Button kind="primary" busy={checking} onClick={onCheck}>{checking ? copy.setup.checking : copy.setup.checkAgain}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Live readiness and copyable setup steps for each integration. Used by the server wizard and by
 * Settings. Readiness comes from the host's environment, so it is the same for every server.
 */
export function IntegrationSetup({ only = ALL_CARDS, openFirstTodo = false }: { only?: IntegrationId[]; openFirstTodo?: boolean }) {
  const identity = useIdentity();
  const [rows, setRows] = useState<SetupRow[]>();
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<Set<IntegrationId>>(new Set());
  const seeded = useRef(false);

  const check = useCallback(async () => {
    setChecking(true); setProblem("");
    try {
      const next = await identity.loadSetupStatus();
      setRows(next);
      if (openFirstTodo && !seeded.current) {
        seeded.current = true;
        const first = only.find(id => next.find(row => row.id === id && !row.ready));
        if (first) setOpen(new Set([first]));
      }
    } catch { setProblem(copy.setup.loadFailed); }
    finally { setChecking(false); }
  }, [identity.loadSetupStatus, openFirstTodo, only.join()]);
  useEffect(() => { if (identity.owner) void check(); }, [identity.owner]);

  if (!identity.owner) return <p className="hc-muted" data-testid="setup-ask-owner">{copy.setup.askOwner}</p>;
  const toggle = (id: IntegrationId) => setOpen(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return (
    <div className="hc-stack" data-testid="integration-setup">
      <p className="hc-muted">{copy.setup.scope}</p>
      <ErrorLine text={problem} />
      <ul className="hc-cards-int">
        {only.map(id => (
          <Card key={id} id={id} row={rows?.find(row => row.id === id)} open={open.has(id)} onToggle={() => toggle(id)} onCheck={() => void check()} checking={checking} />
        ))}
      </ul>
    </div>
  );
}
