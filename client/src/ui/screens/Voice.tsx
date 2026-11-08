import { useEffect, useRef, useState } from 'react';
import type { ScreenProps } from '../../contracts/ui';
import { Icon } from '../icons/Icon';
import { Alert, ContractForm, PhaseNote, fieldIn, find, setNativeValue, useEmit } from '../contract';
import { bytes } from '../format';
import { cx } from '../primitives';
import { parseVoice } from '../parse';
import { setUi } from '../store';

const PRESETS = [
  { bps: 510000, label: '510', note: 'Studio. The default.' },
  { bps: 256000, label: '256', note: 'Still lossless to most ears.' },
  { bps: 128000, label: '128', note: 'Tight connections.' },
  { bps: 64000, label: '64', note: 'Bad hotel wifi.' },
];

const PHASE_COPY: Record<string, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  live: 'Live',
  failed: 'Call failed',
};

/**
 * Engineering renders each remote stream as its own <video data-testid=
 * "remote-media">. The stage shows the same MediaStreams in designed tiles
 * (muted copies, so audio still comes only from engineering's element).
 */
function useRemoteStreams() {
  const [streams, setStreams] = useState<MediaStream[]>([]);
  useEffect(() => {
    const read = () => {
      const next = Array.from(document.querySelectorAll<HTMLVideoElement>('[data-testid="remote-media"]'))
        .map(v => v.srcObject).filter((s): s is MediaStream => s instanceof MediaStream);
      setStreams(prev => (prev.length === next.length && prev.every((s, i) => s === next[i]) ? prev : next));
    };
    read();
    const t = setInterval(read, 500);
    return () => clearInterval(t);
  }, []);
  return streams;
}

function Tile({ stream, n }: { stream: MediaStream; n: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => {});
    return () => { el.srcObject = null; };
  }, [stream]);
  return (
    <figure className={cx('cc-tile', !hasVideo && 'is-audio')}>
      <video ref={ref} muted autoPlay playsInline aria-hidden />
      {!hasVideo && <span className="cc-tile__audio"><Icon name="volume" size={28} /></span>}
      <figcaption><span>Stream {n}</span><span>{hasVideo ? 'camera or screen' : 'audio only'}</span></figcaption>
    </figure>
  );
}

export function VoiceScreen(props: ScreenProps) {
  const emit = useEmit(props);
  useEffect(() => { setUi({ view: 'voice' }); }, []);
  const streams = useRemoteStreams();
  const status = props.items?.find(i => i.id === 'status');
  const v = status ? parseVoice(status.text) : { phase: 'idle' };
  const join = find(props.actions, 'join');
  const joinAudio = find(props.actions, 'join-audio');
  const leave = find(props.actions, 'leave');
  const share = find(props.actions, 'share');
  const mute = find(props.actions, 'mute');
  const back = find(props.actions, 'back');
  const muted = mute?.label === 'Unmute';
  const formRef = useRef<HTMLFormElement>(null);
  const [bitrate, setBitrate] = useState(Number(props.fields?.find(f => f.name === 'bitrate')?.value ?? 510000));

  function preset(bps: number) {
    setBitrate(bps);
    setNativeValue(fieldIn(formRef.current, 'bitrate') as HTMLInputElement, String(bps));
  }

  return (
    <section data-testid="screen-voice" aria-busy={props.busy} className={cx('cc-call', `is-${v.phase}`)} aria-labelledby="cc-call-title">
      <header className="cc-page__head cc-call__head">
        {back && (
          <button type="button" className="cc-back" aria-label={back.label} disabled={props.busy} onClick={() => void emit('back')}>
            <Icon name="chevronLeft" size={18} /><span>Chat</span>
          </button>
        )}
        <div className="cc-page__title">
          <Icon name="voice" size={22} className="cc-page__glyph" />
          <h1 id="cc-call-title" className="cc-display">{props.title}</h1>
        </div>
        <p className={cx('cc-call__state', `is-${v.phase}`)} role="status">
          <span className="cc-call__lamp" aria-hidden />
          <span>{PHASE_COPY[v.phase] ?? v.phase}</span>
        </p>
      </header>
      <PhaseNote phase={props.phase} />
      <Alert error={props.error} />

      <div className="cc-stage" data-count={Math.min(streams.length, 9)}>
        {streams.length > 0
          ? streams.map((s, i) => <Tile key={s.id} stream={s} n={i + 1} />)
          : (
            <div className="cc-stage__empty">
              <p className="cc-display">{v.phase === 'live' ? 'You are in. Nobody else is sending yet.' : v.phase === 'connecting' ? 'Connecting to the room' : v.phase === 'failed' ? 'The call did not connect' : 'Nobody is talking yet'}</p>
              <p>{v.phase === 'idle' ? 'Joining grants microphone access, and camera access if you choose video. Your devices send only during a call. Screen share replaces your camera while it runs.' : v.phase === 'failed' ? (v.error ?? 'Check microphone and camera permission, then join again.') : ''}</p>
            </div>
          )}
      </div>

      <div className="cc-dock" role="toolbar" aria-label="Call controls">
        {/* Controls that do not apply right now are left out rather than shown dead. */}
        {join && !join.disabled && (
          <button type="button" className="cc-btn cc-btn--primary cc-btn--l" disabled={props.busy} aria-label={join.label} onClick={() => void emit('join')}>
            <Icon name="voice" size={19} /><span>Video</span>
          </button>
        )}
        {joinAudio && !joinAudio.disabled && (
          <button type="button" className="cc-btn cc-btn--primary cc-btn--l" disabled={props.busy} aria-label={joinAudio.label} onClick={() => void emit('join-audio')}>
            <Icon name="mic" size={19} /><span>Audio only</span>
          </button>
        )}
        {mute && !mute.disabled && (
          <button type="button" className={cx('cc-dock__btn', muted && 'is-on')} aria-label={mute.label} aria-pressed={muted} data-tip={mute.label} disabled={props.busy || mute.disabled} onClick={() => void emit('mute')}>
            <Icon name={muted ? 'micOff' : 'mic'} size={20} />
          </button>
        )}
        {share && !share.disabled && (
          <button type="button" className="cc-dock__btn" aria-label={share.label} data-tip="Share screen" disabled={props.busy || share.disabled} onClick={() => void emit('share')}>
            <Icon name="screen" size={20} />
          </button>
        )}
        {leave && !leave.disabled && (
          <button type="button" className="cc-dock__btn cc-dock__leave" aria-label={leave.label} data-tip={leave.label} disabled={props.busy} onClick={() => void emit('leave')}>
            <Icon name="hangup" size={26} />
          </button>
        )}
      </div>

      <div className="cc-call__lower">
        <ul className="cc-call__stats" aria-label="Connection">
          {status && (
            <li data-item-id={status.id}>
              <span className="cc-sr">{status.text}</span>
              <span aria-hidden className="cc-call__statline">
                <span>{PHASE_COPY[v.phase] ?? v.phase}</span>
                {v.bytes !== undefined && <span className="cc-num">{bytes(v.bytes)} received</span>}
                {v.frames !== undefined && <span className="cc-num">{Number(v.frames).toLocaleString()} frames decoded</span>}
                {v.error && <span className="cc-call__err">{v.error}</span>}
              </span>
            </li>
          )}
          {props.items?.filter(i => i.id !== 'status').map(i => <li key={i.id} data-item-id={i.id}>{i.text}</li>)}
        </ul>
        <p className="cc-call__fine">Transport counters from your browser. They are not a latency measurement.</p>

        {props.fields?.length ? (
          <div className="cc-audio">
            <h2 className="cc-audio__title">Your audio</h2>
            <div className="cc-presets" role="group" aria-label="Bitrate presets">
              {PRESETS.map(p => (
                <button key={p.bps} type="button" className={cx('cc-preset', bitrate === p.bps && 'is-on')} aria-pressed={bitrate === p.bps} onClick={() => preset(p.bps)}>
                  <strong className="cc-num">{p.label}<small> kbps</small></strong><span>{p.note}</span>
                </button>
              ))}
            </div>
            <ContractForm props={props} formRef={formRef} submitVariant="raised"
              hints={{ bitrate: { inputMode: 'numeric', hint: 'Bits per second. Stereo, fullband Opus. What the network negotiates can be lower.' }, noise_suppression: { hint: 'Off by default so music and room sound come through untouched.' } }}
              render={(f, submit) => (
                <div className="cc-audio__form" onInput={e => { const t = e.target as HTMLInputElement; if (t.name === 'bitrate') setBitrate(Number(t.value)); }}>
                  {f.bitrate}{f.noise_suppression}<div className="cc-form__go">{submit}</div>
                </div>
              )} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
