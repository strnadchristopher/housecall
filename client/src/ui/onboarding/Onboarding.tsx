import { useHosted } from "../../hosted/HostedAccount";
import { useSecurity } from "../../core/securityContext";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Preflight, ServerInfo } from "../../core/identity";
import { useIdentity } from "../../core/context";
import { Logo } from "../brand/Logo";
import { copy } from "../copy";
import { preflightRows } from "../setup/preflight";
import { Button, ErrorLine, Field, IconButton, NavRow, cx } from "../kit";

type Mode = "welcome" | "sign-up" | "server" | "request" | "pending" | "sign-in" | "join" | "setup";
/** An account to log in as that did not come from the remembered list (an approved request). */
type Preset = { origin: string; username: string };

const C = copy.onboarding;
const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };
/** A pasted code or link: the identity adapter does the real check, this only picks the path. */
const looksLikeInvite = (text: string) => /^\s*hc1\./.test(text) || text.includes("#invite=");
const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

/**
 * The way in, full screen. Welcome offers Sign up and Log in. Sign up takes an invite code, an invite link or a
 * server address; an address leads to the server's door (enter a code, or request access). An invite from a link
 * goes straight to Join. Log in surfaces the accounts used on this device. A cold native start that is reopening a
 * stored session shows only the mark.
 */
export function Onboarding() {
  const identity = useIdentity();
  const [mode, setMode] = useState<Mode>(() =>
    identity.inviteToken ? "join" : identity.adding || identity.remembered.length ? "sign-in" : "welcome");
  const [back, setBack] = useState(false);
  const [server, setServer] = useState<ServerInfo>();
  const [preset, setPreset] = useState<Preset>();
  const go = (next: Mode, backwards = false) => {
    if (identity.error) identity.clearError();
    setBack(backwards);
    setMode(next);
  };
  useEffect(() => { if (identity.inviteToken) go("join"); }, [identity.inviteToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const home = () => (identity.adding ? identity.cancelAdd() : go("welcome", true));
  const screens: Record<Mode, () => ReactNode> = {
    welcome: () => <Welcome go={go} />,
    "sign-up": () => <SignUp onBack={home} onServer={info => { setServer(info); go("server"); }} />,
    server: () => server ? <Server onSignIn={() => { setPreset(undefined); go("sign-in"); }} info={server} onBack={() => go("sign-up", true)} onRequest={() => go("request")} /> : null,
    request: () => server ? <Request info={server} onBack={() => go("server", true)} onSent={() => go("pending")} /> : null,
    pending: () => <Pending onBack={() => go("welcome", true)} onLogIn={next => { setPreset(next); go("sign-in"); }} />,
    join: () => <Join name={server?.name} onBack={() => { identity.clearInvite(); home(); }} onHaveAccount={() => go("sign-in")} />,
    "sign-in": () => (
      <SignIn preset={preset} onSignUp={() => go("sign-up")}
        onBack={() => { if (preset) { setPreset(undefined); go("pending", true); } else if (identity.inviteToken) go("join", true); else home(); }} />
    ),
    setup: () => <Setup onBack={home} />,
  };
  return (
    <main className="hc-onb" data-testid={`screen-${mode}`}>
      <div key={mode} className={cx("hc-onb__screen", mode === "welcome" && "hc-welcome", back ? "hc-anim-slide-left" : "hc-anim-slide-right")}>
        {screens[mode]()}
      </div>
    </main>
  );
}

function Top({ onBack }: { onBack: () => void }) {
  return <div className="hc-onb__top"><IconButton icon="back" label={copy.common.back} onClick={onBack} /></div>;
}

/** A screen title, optionally under a lit doorway carrying the server's (or account's) initial. */
function Title({ text, sub, door, tone }: { text: string; sub?: string; door?: string; tone?: "lit" | "quiet" }) {
  return (
    <header className="hc-onb__title">
      {door !== undefined && <span className={cx("hc-onb__door", tone === "quiet" && "is-quiet")} aria-hidden="true">{initial(door)}</span>}
      <h1>{text}</h1>
      {sub && <p>{sub}</p>}
    </header>
  );
}

function Welcome({ go }: { go: (mode: Mode) => void }) {
  const identity = useIdentity();
  const waiting = identity.pendingRequests.length;
  return (
    <>
      <House />
      <div className="hc-welcome__words">
        <h1>{copy.app.name}</h1>
        <p>{C.tagline}</p>
      </div>
      <div className="hc-onb__actions">
        {waiting > 0 && (
          <ul className="hc-navgroup hc-welcome__pending"><li><NavRow label={C.pending} detail={String(waiting)} onClick={() => go("pending")} /></li></ul>
        )}
        <Button kind="primary" onClick={() => go("sign-up")}>{C.signUp}</Button>
        <Button onClick={() => go("sign-in")}>{C.logIn}</Button>
        <Button kind="text" className="hc-onb__quiet" onClick={() => go("setup")}>{C.toSetup}</Button>
      </div>
    </>
  );
}

/**
 * The signature: the Housecall mark built at the scale of a house at night. Its stem rises off the top edge, the
 * doorway is lit in the accent with the door swinging open, and the light falls out across the ground toward the
 * buttons. Drawn on the mark's own 32 unit grid; the grain lives only on the light, never on text.
 */
function House() {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="hc-welcome__scene" viewBox="6 4 20 25" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-spill`} x1="0" y1="29" x2="0" y2="50" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="hc-welcome__stop" stopOpacity="0.30" />
          <stop offset="0.22" className="hc-welcome__stop" stopOpacity="0.17" />
          <stop offset="0.5" className="hc-welcome__stop" stopOpacity="0.07" />
          <stop offset="0.78" className="hc-welcome__stop" stopOpacity="0.02" />
          <stop offset="1" className="hc-welcome__stop" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}-grain`} x="-0.2" y="0" width="1.4" height="1.2">
          {/* One user unit is about 17 px here, so 9 is a fine film grain, not blotches. */}
          <feTurbulence type="fractalNoise" baseFrequency="9" numOctaves="1" seed="7" result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.32 -0.1" result="specks" />
          <feComposite in="specks" in2="SourceGraphic" operator="in" result="grain" />
          <feBlend in="SourceGraphic" in2="grain" mode="screen" />
        </filter>
      </defs>
      <path className="hc-welcome__spill" fill={`url(#${id}-spill)`} filter={`url(#${id}-grain)`} d="M12 29H20L29 50H3Z" />
      <path className="hc-welcome__house" d="M6 -40H12V10.83A10 10 0 0 1 26 20V29H20V20A4 4 0 0 0 12 20V29H6Z" />
      <path className="hc-welcome__lit" d="M12 29V20A4 4 0 0 1 20 20V29Z" />
      <path className="hc-welcome__leaf" d="M12 29V20A4 4 0 0 1 12.6 17.9L15.4 19.6V29Z" />
    </svg>
  );
}

function SignUp({ onBack, onServer }: { onBack: () => void; onServer: (info: ServerInfo) => void }) {
  const identity = useIdentity();
  const [text, setText] = useState(identity.address);
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem("");
    if (!text.trim()) { setProblem(C.signUpHelp); return; }
    if (looksLikeInvite(text)) {
      try { identity.enterInvite(text); } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
      return;
    }
    // The web app already lives on its server: typing that server's own name means this origin.
    const typed = text.trim().replace(/\/+$/, "");
    const address = !identity.native && (typed === location.host || typed === location.origin) ? location.origin : typed;
    setChecking(true);
    try { onServer(await identity.checkServer(address)); }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setChecking(false); }
  };
  return (
    <form className="hc-onb__form" onSubmit={event => void submit(event)} noValidate>
      <Top onBack={onBack} />
      <Title text={C.signUpTitle} />
      <Field label={C.serverOrInvite} value={text} onChange={event => { setText(event.target.value); setProblem(""); }}
        placeholder={identity.native ? "chat.example.com" : location.host} autoCapitalize="none" autoCorrect="off" spellCheck={false}
        autoComplete="off" inputMode="url" enterKeyHint="go" autoFocus required />
      <p className="hc-onb__help">{C.signUpHelp}</p>
      <ErrorLine text={problem} />
      <div className="hc-onb__actions">
        <Button kind="primary" type="submit" busy={checking}>{C.continue}</Button>
      </div>
    </form>
  );
}

/** A server's door: enter an invite code, or (when the owner allows it) ask to be let in. */
function Server({ info, onBack, onRequest, onSignIn }: { onSignIn: () => void; info: ServerInfo; onBack: () => void; onRequest: () => void }) {
  const identity = useIdentity();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem("");
    try { identity.enterInvite(info.origin, code); } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <form className="hc-onb__form" onSubmit={submit} noValidate>
      <Top onBack={onBack} />
      <Title door={info.name} text={C.joinTitle(info.name)} sub={hostOf(info.origin)} />
      <Button kind="text" onClick={onSignIn}>{C.haveAccount}</Button>
      <Field label={C.inviteCode} value={code} onChange={event => { setCode(event.target.value); setProblem(""); }}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="go" required />
      <ErrorLine text={problem} />
      {info.requestsOpen
        ? <ul className="hc-navgroup hc-onb__ask"><li><NavRow label={C.requestAccess} detail={C.requestHint} onClick={onRequest} /></li></ul>
        : <p className="hc-onb__help">{C.closed}</p>}
      <div className="hc-onb__actions">
        <Button kind="primary" type="submit">{C.continue}</Button>
      </div>
    </form>
  );
}

function Request({ info, onBack, onSent }: { info: ServerInfo; onBack: () => void; onSent: () => void }) {
  const identity = useIdentity();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void identity.requestAccess({ origin: info.origin, username: username.trim(), password, message }).then(sent => { if (sent) onSent(); });
  };
  return (
    <form className="hc-onb__form" onSubmit={submit}>
      <Top onBack={onBack} />
      <Title door={info.name} text={C.requestTitle(info.name)} sub={hostOf(info.origin)} />
      <Field label={C.username} value={username} onChange={event => setUsername(event.target.value)}
        autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      <Field label={C.newPassword} type="password" value={password} onChange={event => setPassword(event.target.value)}
        autoComplete="new-password" minLength={12} required />
      <Field label={C.message} value={message} onChange={event => setMessage(event.target.value)} placeholder={C.messageHint} maxLength={500} />
      <ErrorLine text={identity.error} />
      <div className="hc-onb__actions">
        <Button kind="primary" type="submit" busy={identity.busy}>{C.sendRequest}</Button>
      </div>
    </form>
  );
}

/** Requests sent from this device. Checked on open, on Refresh and every 30 seconds while the screen is up. */
function Pending({ onBack, onLogIn }: { onBack: () => void; onLogIn: (account: Preset) => void }) {
  const identity = useIdentity();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const refresh = useRef(identity.refreshPending);
  refresh.current = identity.refreshPending;
  const check = async () => {
    setChecking(true);
    try { await refresh.current(); setChecked(true); } finally { setChecking(false); }
  };
  useEffect(() => {
    void check();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh.current(); }, 30_000);
    // Coming back to the app (or the tab) checks at once: that is when someone looks for an answer.
    const onShow = () => { if (document.visibilityState === "visible") void refresh.current(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onShow); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const status = { pending: C.waiting, approved: C.approved, declined: C.declined };
  return (
    <div className="hc-onb__form">
      <Top onBack={onBack} />
      <Title text={C.pendingTitle} sub={identity.pendingRequests.some(request => request.status === "pending") ? C.pendingHint : undefined} />
      <ul className="hc-requests" aria-live="polite">
        {identity.pendingRequests.map(request => (
          <li key={request.id} className="hc-request" data-status={request.status}>
            <span className="hc-onb__door is-small" aria-hidden="true">{initial(request.serverName)}</span>
            <span className="hc-request__text">
              <strong>{request.serverName}</strong>
              <small>{request.username} · <span className="hc-request__status">{status[request.status]}</span></small>
            </span>
            {request.status === "approved" && (
              <Button kind="primary" onClick={() => onLogIn({ origin: request.origin, username: request.username })}>{C.logIn}</Button>
            )}
            {request.status === "declined" && <Button kind="text" onClick={() => identity.dismissPending(request.id)}>{copy.common.remove}</Button>}
          </li>
        ))}
      </ul>
      <div className="hc-onb__actions">
        {checked && !checking && <p className="hc-onb__help hc-onb__center" role="status">{C.checked}</p>}
        <Button busy={checking} onClick={() => void check()}>{C.refresh}</Button>
      </div>
    </div>
  );
}

function Join({ name, onBack, onHaveAccount }: { name?: string; onBack: () => void; onHaveAccount: () => void }) {
  const identity = useIdentity();
  const origin = identity.address || location.origin;
  const [serverName, setServerName] = useState(name);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (name) return;
    let live = true;
    identity.checkServer(origin).then(info => { if (live) setServerName(info.name); }, () => {});
    return () => { live = false; };
  }, [origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const host = hostOf(origin);
  const phone = typeof navigator !== "undefined" && /iphone|ipad|android/i.test(navigator.userAgent);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void identity.join({ address: identity.address, token: identity.inviteToken, name: username.trim(), password });
  };
  return (
    <form className="hc-onb__form" onSubmit={submit}>
      <Top onBack={onBack} />
      <Title door={serverName ?? host} text={C.joinTitle(serverName ?? host)} sub={serverName ? host : undefined} />
      <Field label={C.username} value={username} onChange={event => setUsername(event.target.value)}
        autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      <Field label={C.newPassword} type="password" value={password} onChange={event => setPassword(event.target.value)}
        autoComplete="new-password" minLength={12} required />
      <ErrorLine text={identity.error} />
      <div className="hc-onb__actions">
        <Button kind="primary" type="submit" busy={identity.busy}>{C.join}</Button>
        {phone && identity.inviteAppLink && <a className="hc-btn hc-btn--plain" href={identity.inviteAppLink}>{C.openInApp}</a>}
        <Button kind="text" className="hc-onb__quiet" onClick={onHaveAccount}>{C.haveAccount}</Button>
      </div>
    </form>
  );
}

/**
 * Log in. Remembered accounts come first as rows (one is picked for you when it is the only one); a picked account
 * needs only its password. "Use another account" and the setup-free path ask for the username (and, in the app,
 * the server's address).
 */
function SignIn({ preset, onBack, onSignUp }: { preset?: Preset; onBack: () => void; onSignUp: () => void }) {
  const hosted = useHosted();
  const security = useSecurity();
  const identity = useIdentity();
  const accounts = identity.remembered;
  const [manual, setManual] = useState(false);
  const [picked, setPicked] = useState<Preset | undefined>(() => preset ?? (accounts.length === 1 ? accounts[0] : undefined));
  const [address, setAddress] = useState(identity.address);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => { if (identity.address) setAddress(identity.address); }, [identity.address]);
  // Name the server you are logging in to, not just its address.
  const target = picked?.origin || identity.address || (identity.native ? "" : location.origin);
  const [serverName, setServerName] = useState<string>();
  useEffect(() => {
    setServerName(undefined);
    if (!target || (!picked && !identity.adding)) return;
    let live = true;
    identity.checkServer(target).then(info => { if (live) setServerName(info.name); }, () => {});
    return () => { live = false; };
  }, [target, !!picked, identity.adding]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = !picked && !manual && accounts.length > 1 && !identity.adding;
  const notYou = () => {
    if (!picked) return;
    if (!preset) identity.forgetAccount(picked.origin, picked.username);
    setPicked(undefined);
    setPassword("");
    setManual(accounts.length <= 1 || !!preset);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked) void identity.signIn({ address: picked.origin, username: picked.username, password });
    else void identity.signIn({ address, username: username.trim(), password });
  };
  const host = hostOf(picked?.origin || identity.address || location.origin);
  return (
    <form className="hc-onb__form" onSubmit={submit}>
      <Top onBack={onBack} />
      {list ? (
        <>
          <Title text={C.logIn} />
          <ul className="hc-navgroup">
            {accounts.map(account => (
              <li key={`${account.origin}|${account.username}`}>
                <NavRow label={account.username} detail={hostOf(account.origin)} onClick={() => setPicked(account)}
                  lead={<span className="hc-onb__door is-tiny is-quiet">{initial(account.username)}</span>} />
              </li>
            ))}
            <li><NavRow label={C.otherAccount} onClick={() => setManual(true)} /></li>
          </ul>
        </>
      ) : (
        <>
          <Title text={picked || identity.adding ? C.logInTo(serverName ?? host) : C.logIn} sub={serverName ? host : undefined} />
          {picked ? (
            <div className="hc-onb__account">
              <span className="hc-onb__door is-small is-quiet" aria-hidden="true">{initial(picked.username)}</span>
              <strong data-testid="sign-in-account">{picked.username}</strong>
              <Button kind="text" onClick={notYou}>{C.notYou}</Button>
            </div>
          ) : (
            <>
              {identity.native && !identity.adding && (
                <Field label={C.address} value={address} onChange={event => setAddress(event.target.value)}
                  inputMode="url" autoComplete="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
              )}
              <Field label={C.username} value={username} onChange={event => setUsername(event.target.value)}
                autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required />
            </>
          )}
          <Field label={C.password} type="password" value={password} onChange={event => setPassword(event.target.value)}
            autoComplete="current-password" autoFocus={!!picked} required />
          {hosted?.account.list && <label className="hc-check"><input type="checkbox" checked={hosted.saveAfterLogin} onChange={e => hosted.setSaveAfterLogin(e.target.checked)} />Save to my HouseCall list</label>}
          <ErrorLine text={identity.error || hosted?.error || ""} />
          <div className="hc-onb__actions">
            <Button kind="primary" type="submit" busy={identity.busy}>{C.logIn}</Button>
            {!hosted && <Button onClick={() => void security?.act(() => security.openReceive())}>{copy.link.title}</Button>}
            {hosted && identity.adding && <Button kind="text" onClick={onSignUp}>Have an invite? Join instead</Button>}
            {!identity.adding && !preset && <Button kind="text" className="hc-onb__quiet" onClick={onSignUp}>{C.newHere}</Button>}
          </div>
        </>
      )}
    </form>
  );
}

function Checklist({ address }: { address: string }) {
  const identity = useIdentity();
  const [result, setResult] = useState<Preflight | undefined | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    void identity.preflight(address).then(value => { if (live) setResult(value); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, run]);
  const P = C.preflight;
  if (result === undefined) return null;
  return (
    <section className="hc-preflight" aria-label={P.title} aria-live="polite" data-testid="preflight">
      <h2 className="hc-preflight__title">{P.title}</h2>
      {result === null ? <p className="hc-preflight__help">{P.checking}</p> : (
        <ul className="hc-preflight__list">
          {preflightRows(result).map(row => (
            <li key={row.id} className="hc-preflight__row" data-ok={row.ok} data-testid={`preflight-${row.id}`}>
              <span className="hc-preflight__mark" aria-hidden="true">{row.ok ? "✓" : "!"}</span>
              <span className="hc-preflight__text">
                <span>{row.label}<span className="hc-sr"> {row.ok ? "passed" : "needs attention"}</span></span>
                {row.help && <span className="hc-preflight__help">{row.help} <a href={`https://github.com/strnadchristopher/housecall/blob/housecall/${row.href}`} target="_blank" rel="noreferrer">{P.guide}</a></span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result && <Button kind="text" type="button" onClick={() => { setResult(null); setRun(n => n + 1); }}>{P.recheck}</Button>}
    </section>
  );
}

function Setup({ onBack }: { onBack: () => void }) {
  const identity = useIdentity();
  const [address, setAddress] = useState(identity.address);
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void identity.setup({ address, setupToken: token.trim(), username: username.trim(), password });
  };
  return (
    <form className="hc-onb__form" onSubmit={submit}>
      <Top onBack={onBack} />
      <Title text={C.setupTitle} />
      <Checklist address={address} />
      {identity.native && (
        <Field label={C.address} value={address} onChange={event => setAddress(event.target.value)}
          inputMode="url" autoComplete="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      )}
      <Field label={C.setupToken} type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required />
      <Field label={C.username} value={username} onChange={event => setUsername(event.target.value)}
        autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      <Field label={C.newPassword} type="password" value={password} onChange={event => setPassword(event.target.value)}
        autoComplete="new-password" minLength={12} required />
      <ErrorLine text={identity.error} />
      <div className="hc-onb__actions">
        <Button kind="primary" type="submit" busy={identity.busy}>{C.setup}</Button>
      </div>
    </form>
  );
}
