import { useEffect, useState } from 'react';
import type { ScreenProps } from '../contracts/ui';
import { Icon } from './icons/Icon';
import { Alert, ContractForm, PhaseNote, useEmit, type FieldHint } from './contract';
import { cx } from './primitives';
import { setUi } from './store';

const COPY: Record<string, { line: string; mode: string }> = {
  login: { line: 'Welcome back. Your passkey is the quick way in.', mode: 'Sign in' },
  invite: { line: 'Christopher invited you. Pick a name and a password and you are in. Add a passkey afterwards under Devices.', mode: 'Use invitation' },
  setup: { line: 'First run. Use the setup token from the server environment to create the owner account.', mode: 'First-run setup' },
};

const MODE_ACTION: Record<string, string> = { login: 'login', invite: 'invite', setup: 'setup' };

/** Setup, invitation and sign-in share one composed scene: the little obelisk at dusk. */
export function OnboardingScreen(props: ScreenProps) {
  const emit = useEmit(props);
  useEffect(() => { setUi({ view: props.id, drawer: false }); }, [props.id]);
  const flow = props.id;
  const copy = COPY[flow] ?? COPY.login;
  const actions = props.actions ?? [];
  const passkey = actions.find(a => a.id === 'passkey');
  const modes = actions.filter(a => a.id !== 'passkey');
  const hasToken = !!props.fields?.find(f => f.name === 'token')?.value;
  const [pw, setPw] = useState(0);
  const pwHint = flow === 'login' ? undefined : pw === 0 ? 'Twelve characters or more. A short sentence works well.' : pw < 12 ? `${12 - pw} more to go.` : 'Long enough.';

  const hints: Record<string, FieldHint> = {
    server_origin: { placeholder: 'https://chat.example.com', inputMode: 'url', autoComplete: 'url' },
    username: { autoComplete: 'username', autoFocus: true },
    password: { autoComplete: flow === 'login' ? 'current-password' : 'new-password', hint: pwHint },
    setup_token: { autoComplete: 'off' },
    token: { autoComplete: 'off', hint: hasToken ? 'Filled in from your invite link.' : 'Paste the token from your invite link.' },
  };

  return (
    <section data-testid={`screen-${props.id}`} aria-busy={props.busy} className={cx('cc-onb', `cc-onb--${flow}`)} aria-labelledby="cc-onb-title">
      <Scene />
      <div className="cc-onb__panel">
        <h1 id="cc-onb-title" className="cc-onb__title cc-display">{props.title}</h1>
        <p className="cc-onb__line">{copy.line}</p>
        {flow === 'invite' && (
          <ol className="cc-steps" aria-label="Joining">
            <li className={hasToken ? 'is-done' : 'is-now'}><Icon name={hasToken ? 'check' : 'key'} size={14} /><span>Invitation</span></li>
            <li className={hasToken ? 'is-now' : ''}><Icon name="user" size={14} /><span>Name and password</span></li>
            <li><Icon name="arrowUpRight" size={14} /><span>In</span></li>
          </ol>
        )}
        <PhaseNote phase={props.phase} />
        <Alert error={props.error} />

        {passkey && flow === 'login' && (
          <>
            <button type="button" className="cc-btn cc-btn--primary cc-btn--l cc-onb__passkey" disabled={props.busy || passkey.disabled} onClick={() => void emit('passkey')}>
              <Icon name="fingerprint" size={20} /><span>{passkey.label}</span>
            </button>
            <p className="cc-onb__or"><span>or with your password</span></p>
          </>
        )}

        <div className="cc-onb__formwrap" onInput={e => { const t = e.target as HTMLInputElement; if (t.name === 'password') setPw(t.value.length); }}>
        <ContractForm props={props} hints={hints} submitIcon={flow === 'login' ? undefined : 'arrowUpRight'}
          render={(f, submit) => (
            <>
              {f.setup_token}
              {f.token}
              {f.username}
              {f.password}
              {f.server_origin && (
                <details className="cc-onb__server" open={!!props.fields?.find(x => x.name === 'server_origin')?.value}>
                  <summary><Icon name="globe" size={15} /><span>Connecting from the desktop or phone app?</span></summary>
                  {f.server_origin}
                </details>
              )}
              <div className="cc-onb__go">{submit}</div>
            </>
          )} />
        </div>

        {passkey && flow !== 'login' && (
          <button type="button" className="cc-btn cc-btn--quiet cc-onb__alt" disabled={props.busy || passkey.disabled} onClick={() => void emit('passkey')}>
            <Icon name="fingerprint" size={18} /><span>{passkey.label}</span>
          </button>
        )}

        <div className="cc-onb__modes" aria-label="Other ways in">
          {modes.map(a => (
            <button key={a.id} type="button" className={cx('cc-onb__mode', MODE_ACTION[flow] === a.id && 'is-current')} aria-current={MODE_ACTION[flow] === a.id ? 'page' : undefined}
              disabled={props.busy || a.disabled} onClick={() => void emit(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The signature artifact: a dressed-stone obelisk on a stepped plinth, lit
 * from the low left by the last of the day, casting a long shadow right.
 * Two layers so the wordmark can sit between sky and stone.
 */
function Scene() {
  return (
    <div className="cc-scene" aria-hidden>
      <svg className="cc-scene__back" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="cc-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--cc-sky-top)" />
            <stop offset="0.72" stopColor="var(--cc-sky-bottom)" />
            <stop offset="1" stopColor="var(--cc-sky-bottom)" />
          </linearGradient>
          <linearGradient id="cc-dusk" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--cc-light)" stopOpacity="0.55" />
            <stop offset="0.35" stopColor="var(--cc-light)" stopOpacity="0.22" />
            <stop offset="0.75" stopColor="var(--cc-light)" stopOpacity="0.04" />
            <stop offset="1" stopColor="var(--cc-light)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="cc-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.7" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="cc-band-m"><rect x="0" y="470" width="1600" height="300" fill="url(#cc-band)" /></mask>
          <filter id="cc-grain-f" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.9 0" />
          </filter>
        </defs>
        <rect width="1600" height="1000" fill="url(#cc-sky)" />
        <rect className="cc-scene__dusk" x="0" y="470" width="1600" height="300" fill="url(#cc-dusk)" mask="url(#cc-band-m)" />
        {[[180, 120, 2.2], [420, 210, 1.6], [760, 90, 2], [1010, 170, 1.4], [1340, 110, 2.4], [1490, 260, 1.5], [620, 300, 1.2], [1220, 330, 1.3]].map(([x, y, r], i) => (
          <polygon key={i} className={i % 3 === 0 ? 'cc-scene__star is-slow' : 'cc-scene__star'} points={`${x},${y - r * 2} ${x + r},${y} ${x},${y + r * 2} ${x - r},${y}`} fill="var(--cc-light)" />
        ))}
        <path d="M0 708 C 140 690 260 668 420 676 C 600 684 700 650 860 656 C 1020 662 1120 690 1290 680 C 1420 672 1520 690 1600 684 L1600 1000 L0 1000 Z" fill="var(--cc-stone)" opacity="0.55" />
        <path d="M0 742 C 220 728 420 736 640 730 C 900 724 1180 738 1600 732 L1600 1000 L0 1000 Z" fill="var(--cc-ground)" />
        <rect className="cc-scene__grain" width="1600" height="1000" filter="url(#cc-grain-f)" />
      </svg>
      <p className="cc-scene__word cc-display">Housecall</p>
      <svg className="cc-scene__front" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="cc-lit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--cc-stone-lit)" />
            <stop offset="0.55" stopColor="color-mix(in srgb, var(--cc-stone-lit) 62%, var(--cc-stone))" />
            <stop offset="1" stopColor="var(--cc-stone)" />
          </linearGradient>
          <linearGradient id="cc-cast" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--cc-bg)" stopOpacity="0.7" />
            <stop offset="1" stopColor="var(--cc-bg)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="cc-jewel" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--cc-light)" />
            <stop offset="0.6" stopColor="var(--cc-accent)" />
            <stop offset="1" stopColor="var(--cc-stone-lit)" />
          </linearGradient>
        </defs>
        {/* long cast shadow, low sun from the left */}
        <polygon points="1132,800 1600,770 1600,812 1150,824" fill="url(#cc-cast)" />
        {/* plinth: three dressed steps */}
        <polygon points="1000,808 1220,808 1232,826 988,826" fill="var(--cc-stone)" />
        <polygon points="1000,808 1110,808 1110,826 988,826" fill="url(#cc-lit)" opacity="0.55" />
        <polygon points="1022,786 1198,786 1208,808 1012,808" fill="var(--cc-stone)" />
        <polygon points="1022,786 1110,786 1110,808 1012,808" fill="url(#cc-lit)" opacity="0.7" />
        <polygon points="1044,766 1176,766 1184,786 1036,786" fill="var(--cc-stone)" />
        <polygon points="1044,766 1110,766 1110,786 1036,786" fill="url(#cc-lit)" opacity="0.85" />
        {/* shaft: lit west face, shaded east face */}
        <polygon points="1082,262 1110,262 1110,766 1066,766" fill="url(#cc-lit)" />
        <polygon points="1110,262 1138,262 1154,766 1110,766" fill="var(--cc-stone)" />
        <polygon points="1110,262 1138,262 1154,766 1110,766" fill="var(--cc-bg)" opacity="0.32" />
        {/* pyramidion with the jewel */}
        <polygon points="1110,196 1082,262 1110,262" fill="url(#cc-jewel)" />
        <polygon points="1110,196 1138,262 1110,262" fill="var(--cc-stone-lit)" opacity="0.4" />
        <polygon className="cc-scene__glint" points="1110,196 1104,212 1110,216 1116,212" fill="var(--cc-light)" />
        {/* the ground in front of the plinth */}
        <path d="M0 826 L1600 820 L1600 1000 L0 1000 Z" fill="var(--cc-ground)" />
      </svg>
    </div>
  );
}
