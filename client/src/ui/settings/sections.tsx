import { useEffect, useRef, useState, type FormEvent } from "react";
import type { InviteResult } from "../../core/identity";
import { useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Button, Field } from "../kit";
import { useNav } from "../shell/nav";

export function Devices() {
  const identity = useIdentity();
  useEffect(() => { void identity.loadDevices(); }, []);
  return (
    <ul className="hc-results" data-testid="screen-devices">
      {identity.devices.map(device => (
        <li key={device.id} className="hc-results__action">
          <span><strong>{device.name}</strong><small>{device.current ? copy.settings.thisDevice : new Date(device.createdAt).toLocaleDateString()}</small></span>
          <Button kind="danger" onClick={() => void identity.revokeDevice(device.id)}>{copy.settings.revoke}</Button>
        </li>
      ))}
    </ul>
  );
}

export function Notifications() {
  const identity = useIdentity();
  const { desktop, background } = identity.notifications;
  return (
    <div className="hc-stack" data-testid="screen-notifications">
      {background === "off" && <Button kind="primary" onClick={() => void identity.enableNotifications()}>{copy.settings.enableBackground}</Button>}
      {background === "on" && <Button onClick={() => void identity.disableBackgroundNotifications()}>{copy.settings.disableBackground}</Button>}
      {background === "unsupported" && desktop === "default" && <Button kind="primary" onClick={() => void identity.enableNotifications()}>{copy.settings.enableDesktop}</Button>}
      {background === "unsupported" && desktop === "granted" && <p className="hc-muted">{copy.settings.desktopOn}</p>}
      {background === "unsupported" && desktop === "denied" && <p className="hc-muted">{copy.settings.desktopBlocked}</p>}
      <h3 className="hc-label">{copy.settings.mentions}</h3>
      <ul className="hc-results">
        {identity.notices.map(notice => <li key={notice.id}><strong>{notice.conversation}</strong><small>{notice.at ? new Date(notice.at).toLocaleString() : ""}</small></li>)}
      </ul>
    </div>
  );
}

export function Invites() {
  const identity = useIdentity();
  const [result, setResult] = useState<InviteResult>();
  const [expires, setExpires] = useState("604800");
  const [copied, setCopied] = useState(false);
  const create = (event: FormEvent) => {
    event.preventDefault();
    setCopied(false);
    void identity.createInvite({ expiresInSeconds: Number(expires) }).then(next => setResult(next.link ? next : result));
  };
  const copyLink = async () => {
    if (!result?.link) return;
    try { await navigator.clipboard.writeText(result.link); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <form className="hc-stack" data-testid="screen-invites" onSubmit={create}>
      <label className="hc-field">
        <span className="hc-field__label">{copy.settings.expires}</span>
        <select value={expires} onChange={event => setExpires(event.target.value)}>
          <option value="3600">{copy.settings.hour}</option>
          <option value="86400">{copy.settings.day}</option>
          <option value="604800">{copy.settings.week}</option>
        </select>
      </label>
      <Button kind="primary" type="submit" busy={identity.busy}>{copy.settings.invite}</Button>
      {result?.link && (
        <div className="hc-copy">
          <Field label={copy.settings.inviteLink} value={result.link} readOnly onFocus={event => event.target.select()} data-testid="invite-link" />
          <Button onClick={() => void copyLink()}>{copied ? copy.common.copied : copy.common.copy}</Button>
        </div>
      )}
    </form>
  );
}

function PeoplePicker({ picked, onChange }: { picked: string[]; onChange: (ids: string[]) => void }) {
  const chat = useChat();
  return (
    <fieldset className="hc-checks">
      <legend className="hc-field__label">{copy.settings.members}</legend>
      {chat.friends.filter(person => person.id !== chat.me.id).map(person => (
        <label key={person.id} className="hc-check">
          <input type="checkbox" checked={picked.includes(person.id)}
            onChange={event => onChange(event.target.checked ? [...picked, person.id] : picked.filter(id => id !== person.id))} />
          <span>{person.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Channels() {
  const chat = useChat();
  const nav = useNav();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const create = (event: FormEvent) => {
    event.preventDefault();
    void chat.createChannel(name.trim(), members).then(ok => { if (ok) nav.set({ main: "chat", left: "channels" }); });
  };
  return (
    <form className="hc-stack" data-testid="screen-channels" onSubmit={create}>
      <Field label={copy.settings.channelName} value={name} onChange={event => setName(event.target.value)} maxLength={80} required />
      <PeoplePicker picked={members} onChange={setMembers} />
      <Button kind="primary" type="submit" busy={chat.busy}>{copy.settings.createChannel}</Button>
    </form>
  );
}

export function Roles() {
  const identity = useIdentity();
  const chat = useChat();
  const [name, setName] = useState("");
  useEffect(() => { void identity.loadRoles(); }, []);
  const create = (event: FormEvent) => { event.preventDefault(); void identity.createRole(name.trim()).then(ok => { if (ok) setName(""); }); };
  return (
    <div className="hc-stack" data-testid="screen-roles">
      <form className="hc-inline" onSubmit={create}>
        <Field label={copy.settings.roleName} value={name} onChange={event => setName(event.target.value)} required />
        <Button kind="primary" type="submit">{copy.settings.createRole}</Button>
      </form>
      <ul className="hc-results">
        {identity.roles.map(role => (
          <li key={role.id} className="hc-results__action">
            <span><strong>{role.name}</strong><small>{copy.settings.roleMembers(role.memberIds.length)}</small></span>
            <select aria-label={`${copy.settings.assign}: ${role.name}`} value="" onChange={event => { if (event.target.value) void identity.assignRole(role.id, event.target.value); }}>
              <option value="">{copy.settings.assign}</option>
              {chat.friends.filter(person => !role.memberIds.includes(person.id)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            <Button kind="danger" onClick={() => void identity.deleteRole(role.id)}>{copy.settings.deleteRole}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReportProblem() {
  const identity = useIdentity();
  const [body, setBody] = useState("");
  const [feature, setFeature] = useState(false);
  const [logs, setLogs] = useState("");
  const [logsConsent, setLogsConsent] = useState(false);
  const [screenshotConsent, setScreenshotConsent] = useState(false);
  const [sent, setSent] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSent(false);
    void identity.submitReport({ kind: feature ? "feature" : "bug", body, logs, logsConsent, screenshot: file.current?.files?.[0], screenshotConsent })
      .then(() => { setBody(""); setLogs(""); setLogsConsent(false); setScreenshotConsent(false); if (file.current) file.current.value = ""; setSent(true); });
  };
  return (
    <form className="hc-stack" data-testid="screen-report" onSubmit={submit}>
      <div className="hc-inline" role="radiogroup" aria-label={copy.settings.report}>
        <label className="hc-check"><input type="radio" name="kind" checked={!feature} onChange={() => setFeature(false)} /><span>{copy.settings.bug}</span></label>
        <label className="hc-check"><input type="radio" name="kind" checked={feature} onChange={() => setFeature(true)} /><span>{copy.settings.feature}</span></label>
      </div>
      <label className="hc-field"><span className="hc-field__label">{copy.settings.reportBody}</span>
        <textarea rows={4} value={body} onChange={event => setBody(event.target.value)} required /></label>
      <label className="hc-field"><span className="hc-field__label">{copy.settings.logs}</span>
        <textarea rows={3} value={logs} onChange={event => setLogs(event.target.value)} /></label>
      <label className="hc-check"><input type="checkbox" checked={logsConsent} onChange={event => setLogsConsent(event.target.checked)} /><span>{copy.settings.logsConsent}</span></label>
      <label className="hc-field"><span className="hc-field__label">{copy.settings.screenshot}</span>
        <input ref={file} type="file" name="report_screenshot" accept="image/png,image/jpeg,image/webp" /></label>
      <label className="hc-check"><input type="checkbox" checked={screenshotConsent} onChange={event => setScreenshotConsent(event.target.checked)} /><span>{copy.settings.screenshotConsent}</span></label>
      <Button kind="primary" type="submit" busy={identity.busy}>{copy.settings.submitReport}</Button>
      {sent && !identity.error && <p className="hc-muted" role="status">{copy.settings.reportSent}</p>}
    </form>
  );
}

export function Reports() {
  const identity = useIdentity();
  useEffect(() => { void identity.loadReports(); }, []);
  return (
    <ul className="hc-results" data-testid="screen-reports">
      {identity.reports.length === 0 && <li className="hc-muted">{copy.settings.noReports}</li>}
      {identity.reports.map(report => (
        <li key={report.id} className="hc-results__action">
          <span>
            <small>{report.kind === "feature" ? copy.settings.feature : copy.settings.bug} · {report.status === "resolved" ? copy.settings.resolved : copy.settings.open}</small>
            <strong>{report.body}</strong>
            {report.logs && <code>{report.logs}</code>}
          </span>
          {report.hasScreenshot && <Button onClick={() => void identity.downloadReportScreenshot(report.id)}>{copy.settings.downloadScreenshot}</Button>}
          {report.status !== "resolved" && <Button kind="primary" onClick={() => void identity.resolveReport(report.id)}>{copy.settings.resolve}</Button>}
        </li>
      ))}
    </ul>
  );
}

export function About() {
  const identity = useIdentity();
  return (
    <ul className="hc-results" data-testid="screen-about">
      {identity.capabilities.filter(capability => capability.id in copy.capabilities).map(capability => (
        <li key={capability.id} className="hc-pair">
          <span>{copy.capabilities[capability.id]}</span>
          <strong>{capability.available ? copy.settings.available : copy.settings.unavailable}</strong>
        </li>
      ))}
    </ul>
  );
}
