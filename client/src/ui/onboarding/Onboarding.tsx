import { useEffect, useState, type FormEvent } from "react";
import { useIdentity } from "../../core/context";
import { Logo } from "../brand/Logo";
import { copy } from "../copy";
import { Button, ErrorLine, Field } from "../kit";

type Mode = "sign-in" | "join" | "setup";

/**
 * Sign in, accept an invite, or first-admin setup: the three ways in that
 * the current backend has. One form each; an invite link fills the token.
 */
export function Onboarding() {
  const identity = useIdentity();
  const [mode, setMode] = useState<Mode>(identity.inviteToken ? "join" : "sign-in");
  const [address, setAddress] = useState(identity.address);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => { if (identity.inviteToken) setMode("join"); }, [identity.inviteToken]);
  useEffect(() => { if (identity.address) setAddress(identity.address); }, [identity.address]);

  const title = mode === "join" ? copy.onboarding.join : mode === "setup" ? copy.onboarding.setup : copy.onboarding.signIn;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "sign-in") void identity.signIn({ address, username, password });
    else if (mode === "join") void identity.join({ address, token: identity.inviteToken || token.trim(), name: username, password });
    else void identity.setup({ address, setupToken: token.trim(), username, password });
  };
  const others = (["sign-in", "join", "setup"] as const).filter(candidate => candidate !== mode && !(candidate === "setup" && (identity.adding || identity.inviteToken)));
  const label = { "sign-in": copy.onboarding.toSignIn, join: copy.onboarding.toJoin, setup: copy.onboarding.toSetup };

  return (
    <main className="hc-onb" data-testid={`screen-${mode}`}>
      <form className="hc-onb__form" onSubmit={submit} aria-labelledby="hc-onb-title">
        <div className="hc-onb__brand"><Logo /><span>{copy.app.name}</span></div>
        <h1 id="hc-onb-title">{title}</h1>
        {identity.adding && <p className="hc-onb__host">{identity.address}</p>}
        {identity.native && !identity.adding && (
          <Field label={copy.onboarding.address} value={address} onChange={event => setAddress(event.target.value)}
            inputMode="url" autoComplete="url" autoCapitalize="none" required />
        )}
        {mode === "setup" && (
          <Field label={copy.onboarding.setupToken} type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required />
        )}
        {mode === "join" && !identity.inviteToken && (
          <Field label={copy.onboarding.inviteToken} type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required />
        )}
        <Field label={mode === "join" ? copy.onboarding.name : copy.onboarding.username} value={username}
          onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
        <Field label={mode === "sign-in" ? copy.onboarding.password : copy.onboarding.newPassword} type="password" value={password}
          onChange={event => setPassword(event.target.value)} autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          minLength={mode === "sign-in" ? undefined : 12} required />
        <ErrorLine text={identity.error} />
        <Button kind="primary" type="submit" busy={identity.busy} className="hc-onb__go">{title}</Button>
        <div className="hc-onb__modes">
          {others.map(candidate => (
            <Button key={candidate} kind="text" onClick={() => { identity.clearError(); setToken(""); setMode(candidate); }}>{label[candidate]}</Button>
          ))}
          {identity.adding && <Button kind="text" onClick={identity.cancelAdd}>{copy.common.back}</Button>}
        </div>
      </form>
    </main>
  );
}
