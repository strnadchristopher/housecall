import { DirectorySettings } from "../../hosted/DirectorySettings";
import { NavRow } from "../kit";
import { useSecurity } from "../../core/securityContext";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ACCENTS, type AccentId } from "../tokens/accent";
import type { AccessRequestRecord, InviteRecord, InviteResult } from "../../core/identity";
import { useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Avatar, Button, Field, Icon, MediaDropzone, cx } from "../kit";
import { BIO_MAX, normalizeBio } from "../../data/bio";
import { CLIENT_VERSION } from "../../version";
import { useNav } from "../shell/nav";
import { prepareImage } from "./resizeImage";

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PICTURE_PICK_LIMIT = 8 * 1024 * 1024;

/** Picks an image, shrinks it on this device (a GIF is kept as is), then uploads it. Shared by the avatar and the server icon. */
function PictureField({ label, remove, saveLabel, current, shape, name, save, clear }: {
  label: string; remove: string; saveLabel: string; current?: string; shape: "arch" | "squircle"; name: string;
  save: (image: Blob) => Promise<boolean>; clear: () => Promise<boolean>;
}) {
  const identity = useIdentity();
  const [file, setFile] = useState<File>();
  const [problem, setProblem] = useState("");
  const upload = async () => {
    if (!file) return;
    setProblem("");
    try {
      if (await save(await prepareImage(file))) setFile(undefined);
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <div className="hc-stack">
      <MediaDropzone label={label} accept={PICTURE_TYPES} maxBytes={PICTURE_PICK_LIMIT} hint={copy.profile.pictureHint} typeError={copy.profile.pictureType} value={file} onChange={next => { setProblem(""); setFile(next); }}
        lead={!file && shape === "squircle" ? <p className="hc-person"><Avatar name={name} src={current} size="lg" shape={shape} /></p> : undefined} />
      {problem && <p className="hc-field__error" role="alert">{problem}</p>}
      <div className="hc-inline">
        {file && <Button kind="primary" busy={identity.busy} onClick={() => void upload()}>{saveLabel}</Button>}
        {!file && current && <Button kind="danger" busy={identity.busy} onClick={() => void clear()}>{remove}</Button>}
      </div>
    </div>
  );
}

export function Account() {
  const identity = useIdentity();
  const me = identity.me!;
  const [name, setName] = useState(me.name === me.username ? "" : me.name);
  const saved = me.name === me.username ? "" : me.name;
  const [bio, setBio] = useState(me.bio ?? "");
  const [justSaved, setJustSaved] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void identity.setProfile(name.trim() || null, normalizeBio(bio)).then(ok => { setJustSaved(ok); if (ok) setBio(normalizeBio(bio) ?? ""); });
  };
  const count = bio.length;
  const preview = normalizeBio(bio);
  return (
    <div className="hc-stack hc-profile" data-testid="screen-account">
      <div className="hc-profile__card" aria-label={copy.profile.howOthersSee}>
        <Avatar name={name.trim() || me.username} src={me.avatarUrl} size="xl" />
        <div>
          <h3>{name.trim() || me.username}</h3>
          <small>{me.username} · {identity.serverName}</small>
          <p className={preview ? undefined : "is-empty"} data-testid="bio-preview">{preview ?? copy.profile.noBio}</p>
        </div>
      </div>
      <form className="hc-profile__fields" onSubmit={submit}>
        <Field label={copy.profile.displayName} value={name} placeholder={me.username} maxLength={32} onChange={event => { setName(event.target.value); setJustSaved(false); }} />
        <label className="hc-field">
          <span className="hc-field__row"><span className="hc-field__label">{copy.profile.bio}</span>
            <span className={cx("hc-field__count", count > BIO_MAX - 20 && "is-near", count > BIO_MAX && "is-over")} aria-live="polite" data-testid="bio-count">{copy.profile.bioCount(count, BIO_MAX)}</span></span>
          <textarea className="hc-bio" aria-label={copy.profile.bio} rows={3} maxLength={BIO_MAX} value={bio} onChange={event => { setBio(event.target.value); setJustSaved(false); }} />
        </label>
        <div className="hc-profile__save">
          <Button kind="primary" type="submit" busy={identity.busy} disabled={name.trim() === saved && (normalizeBio(bio) ?? "") === (me.bio ?? "")}>{copy.profile.saveProfile}</Button>
          {justSaved && <span className="hc-muted" role="status">{copy.profile.saved}</span>}
        </div>
      </form>
      <PictureField label={copy.profile.avatar} remove={copy.profile.removeAvatar} saveLabel={copy.profile.saveAvatar}current={me.avatarUrl} shape="arch" name={me.name}
        save={image => identity.setAvatar(image)} clear={() => identity.setAvatar(undefined)} />
      <p className="hc-note">{identity.native ? copy.security.signOutNative : copy.security.signOutWeb}</p>
      <Button kind="danger" onClick={() => void identity.signOut()}>{copy.settings.signOut}</Button>
    </div>
  );
}

export function ServerProfile() {
  const identity = useIdentity();
  const [name, setName] = useState(identity.serverName);
  useEffect(() => setName(identity.serverName), [identity.serverName]);
  const submit = (event: FormEvent) => { event.preventDefault(); void identity.renameServer(name.trim()); };
  return (
    <div className="hc-stack" data-testid="screen-server">
      <form className="hc-inline" onSubmit={submit}>
        <Field label={copy.profile.serverName} value={name} maxLength={48} required onChange={event => setName(event.target.value)} />
        <Button kind="primary" type="submit" busy={identity.busy} disabled={!name.trim() || name.trim() === identity.serverName}>{copy.profile.saveName}</Button>
      </form>
      <PictureField label={copy.profile.serverIcon} remove={copy.profile.removeIcon} saveLabel={copy.profile.saveIcon}current={identity.serverIconUrl} shape="squircle" name={identity.serverName}
        save={image => identity.setServerIcon(image)} clear={() => identity.setServerIcon(undefined)} />
      {identity.serverId === "home" && <DirectorySettings />}
    </div>
  );
}

export function Devices() {
  const security = useSecurity();
  const identity = useIdentity();
  useEffect(() => { void identity.loadDevices(); }, []);
  return (
    <ul className="hc-results" data-testid="screen-devices">
      {identity.native && <li><NavRow label={copy.link.title} onClick={() => security?.openShowing()} /></li>}
      <li className="hc-note">{copy.security.stolen}</li>
      {identity.devices.map(device => (
        <li key={device.id} className="hc-results__action">
          <span><strong>{device.name}</strong>{device.addedVia && <small>{copy.link.addedVia[device.addedVia]}</small>}<small>{device.current ? copy.settings.thisDevice : new Date(device.createdAt).toLocaleDateString()}</small></span>
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

/** A read-only value with its own Copy button that says Copied for a moment. */
function CopyField({ label, value, testId, mono }: { label: string; value: string; testId: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const write = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="hc-copy">
      <Field label={label} value={value} readOnly onFocus={event => event.target.select()} data-testid={testId} className={mono ? "hc-field--mono" : undefined} />
      <Button aria-label={`${copy.common.copy} ${label.toLowerCase()}`} onClick={() => void write()}>{copied ? copy.common.copied : copy.common.copy}</Button>
    </div>
  );
}

const USES = [["1", copy.settings.once], ["5", copy.settings.times(5)], ["25", copy.settings.times(25)], ["unlimited", copy.settings.unlimited]] as const;
const LIFETIMES = [["3600", copy.settings.hour], ["86400", copy.settings.day], ["604800", copy.settings.week], ["2592000", copy.settings.month], ["never", copy.settings.never]] as const;
const shortDate = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Owner: make an invite (how many people, how long), hand over its code or link, and see or revoke the ones that
 * still work. Spent and expired invites are not listed; they no longer let anyone in.
 */
export function Invites() {
  const identity = useIdentity();
  const [result, setResult] = useState<InviteResult>();
  const [uses, setUses] = useState("1");
  const [expires, setExpires] = useState("604800");
  const [invites, setInvites] = useState<InviteRecord[]>();
  const [confirming, setConfirming] = useState("");
  const load = useRef(identity.loadInvites);
  load.current = identity.loadInvites;
  const reload = () => load.current().then(setInvites, () => setInvites(list => list ?? []));
  useEffect(() => { void reload(); }, [identity.serverId]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = (event: FormEvent) => {
    event.preventDefault();
    void identity.createInvite({
      expiresInSeconds: expires === "never" ? null : Number(expires),
      maxUses: uses === "unlimited" ? null : Number(uses),
    }).then(next => { if (next.link) setResult(next); void reload(); });
  };
  const revoke = (id: string) => void identity.revokeInvite(id).then(() => { setConfirming(""); void reload(); });
  const now = Date.now();
  const live = (invites ?? []).filter(invite => (invite.expiresAt === null || invite.expiresAt > now) && (invite.maxUses === null || invite.uses < invite.maxUses));
  return (
    <div className="hc-stack hc-invites" data-testid="screen-invites">
      <form className="hc-stack" onSubmit={create}>
        <div className="hc-invites__choices">
          <label className="hc-field">
            <span className="hc-field__label">{copy.settings.canBeUsed}</span>
            <select value={uses} onChange={event => setUses(event.target.value)}>
              {USES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="hc-field">
            <span className="hc-field__label">{copy.settings.expires}</span>
            <select value={expires} onChange={event => setExpires(event.target.value)}>
              {LIFETIMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <Button kind="primary" type="submit" busy={identity.busy}>{copy.settings.invite}</Button>
      </form>
      {result?.link && (
        <div className="hc-invites__result hc-anim-pop">
          {result.code && <CopyField label={copy.settings.inviteCode} value={result.code} testId="invite-code" mono />}
          <CopyField label={copy.settings.inviteLink} value={result.link} testId="invite-link" />
        </div>
      )}
      <section className="hc-stack" aria-label={copy.settings.activeInvites}>
        <h3 className="hc-label">{copy.settings.activeInvites}</h3>
        <ul className="hc-tiles" data-testid="active-invites">
          {invites && live.length === 0 && <li className="hc-tile-row is-empty">{copy.settings.noInvites}</li>}
          {live.map(invite => (
            <li key={invite.id} className="hc-tile-row">
              {confirming === invite.id ? (
                <>
                  <span className="hc-tile-row__text"><strong>{copy.settings.revokeInvite}</strong><small>{copy.settings.revokeHint}</small></span>
                  <Button kind="text" onClick={() => setConfirming("")}>{copy.common.cancel}</Button>
                  <Button kind="danger" busy={identity.busy} onClick={() => revoke(invite.id)}>{copy.settings.revoke}</Button>
                </>
              ) : (
                <>
                  <span className="hc-tile-row__text">
                    <strong>{copy.settings.used(invite.uses, invite.maxUses)}</strong>
                    <small>{invite.expiresAt === null ? copy.settings.neverExpires : copy.settings.expiresOn(shortDate(invite.expiresAt))}</small>
                  </span>
                  <Button kind="text" className="hc-btn--danger-text" onClick={() => setConfirming(invite.id)}>{copy.settings.revoke}</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Owner: people who asked to join, oldest decision first, and whether asking is allowed at all. */
export function AccessRequests() {
  const identity = useIdentity();
  const [requests, setRequests] = useState<AccessRequestRecord[]>();
  const load = useRef(identity.loadAccessRequests);
  load.current = identity.loadAccessRequests;
  const reload = () => load.current().then(setRequests, () => setRequests(list => list ?? []));
  useEffect(() => { void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = (requests ?? []).filter(request => request.status === "pending");
  return (
    <div className="hc-stack" data-testid="screen-access">
      <label className="hc-check hc-switchrow">
        <input type="checkbox" role="switch" checked={identity.accessRequestsOpen}
          onChange={event => void identity.setAccessRequestsOpen(event.target.checked)} />
        <span>{copy.settings.accessOpen}</span>
      </label>
      <ul className="hc-tiles">
        {requests && waiting.length === 0 && <li className="hc-tile-row is-empty">{copy.settings.noRequests}</li>}
        {waiting.map(request => (
          <li key={request.id} className="hc-tile-row hc-tile-row--request">
            <Avatar name={request.username} />
            <span className="hc-tile-row__text">
              <strong>{request.username}</strong>
              {request.message && <span className="hc-tile-row__message">{request.message}</span>}
              <small>{shortDate(request.createdAt)}</small>
            </span>
            <span className="hc-tile-row__actions">
              <Button kind="text" className="hc-btn--danger-text" aria-label={copy.settings.declineWho(request.username)}
                onClick={() => void identity.declineAccessRequest(request.id).then(reload)}>{copy.settings.decline}</Button>
              <Button kind="primary" aria-label={copy.settings.approveWho(request.username)}
                onClick={() => void identity.approveAccessRequest(request.id).then(reload)}>{copy.settings.approve}</Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Members: inviting is the owner's, so say who to ask (and offer to message them). */
export function InvitePeople() {
  const identity = useIdentity();
  const chat = useChat();
  const nav = useNav();
  const owner = chat.people.find(person => person.owner && person.id !== chat.me.id);
  // Its own flag: the chat's busy covers unrelated background work and would dim this button.
  const [opening, setOpening] = useState(false);
  return (
    <div className="hc-stack" data-testid="screen-invite-people">
      <p className="hc-lede">{copy.settings.askOwner(owner?.name, identity.serverName)}</p>
      {owner && (
        <Button kind="primary" className="hc-btn--start" busy={opening}
          onClick={() => { setOpening(true); void chat.startDirect([owner.id], "").then(ok => { setOpening(false); if (ok) nav.set({ main: "chat", section: null, left: "dm" }); }); }}>
          {copy.settings.messageOwner(owner.name)}
        </Button>
      )}
    </div>
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
  const secureChat = useChat().dmSecurity;
  const identity = useIdentity();
  const [body, setBody] = useState("");
  const [feature, setFeature] = useState(false);
  const [logs, setLogs] = useState("");
  const [logsConsent, setLogsConsent] = useState(false);
  const [screenshotConsent, setScreenshotConsent] = useState(false);
  const [sent, setSent] = useState(false);
  const [shot, setShot] = useState<File>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSent(false);
    void identity.submitReport({ kind: feature ? "feature" : "bug", body, logs, logsConsent, screenshot: shot, screenshotConsent })
      .then(ok => { if (!ok) return; setBody(""); setLogs(""); setLogsConsent(false); setScreenshotConsent(false); setShot(undefined); setSent(true); });
  };
  return (
    <form className="hc-stack" data-testid="screen-report" onSubmit={submit}>
      {secureChat && secureChat.peer.state !== "NONE" && <p className="hc-note">{copy.e2e.reportShares}</p>}
      <div className="hc-inline" role="radiogroup" aria-label={copy.settings.report}>
        <label className="hc-check"><input type="radio" name="kind" checked={!feature} onChange={() => setFeature(false)} /><span>{copy.settings.bug}</span></label>
        <label className="hc-check"><input type="radio" name="kind" checked={feature} onChange={() => setFeature(true)} /><span>{copy.settings.feature}</span></label>
      </div>
      <label className="hc-field"><span className="hc-field__label">{copy.settings.reportBody}</span>
        <textarea rows={4} value={body} onChange={event => setBody(event.target.value)} required /></label>
      <label className="hc-field"><span className="hc-field__label">{copy.settings.logs}</span>
        <textarea rows={3} value={logs} onChange={event => setLogs(event.target.value)} /></label>
      <label className="hc-check"><input type="checkbox" checked={logsConsent} onChange={event => setLogsConsent(event.target.checked)} /><span>{copy.settings.logsConsent}</span></label>
      <MediaDropzone label={copy.settings.screenshot} accept={["image/png", "image/jpeg", "image/webp"]} maxBytes={8 * 1024 * 1024} value={shot} onChange={setShot} />
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

/**
 * Accent colour for this device. Each choice is a doorway (the brand's arch) filled with the accent as it looks
 * in the current scheme; the chosen one carries a check. A radio group: Tab lands on the choice, arrows move it.
 */
export function Appearance({ accent, onChange }: { accent: AccentId; onChange: (id: AccentId) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (index: number) => {
    const next = (index + ACCENTS.length) % ACCENTS.length;
    onChange(ACCENTS[next].id);
    buttons.current[next]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (step === undefined) return;
    event.preventDefault();
    pick(index + step);
  };
  return (
    <div className="hc-stack" data-testid="screen-appearance">
      <div role="radiogroup" aria-label={copy.settings.accent} className="hc-swatches">
        {ACCENTS.map((option, index) => {
          const chosen = accent === option.id;
          return (
            <button key={option.id} ref={element => { buttons.current[index] = element; }} type="button" role="radio" aria-checked={chosen}
              tabIndex={chosen ? 0 : -1} className="hc-swatch" onClick={() => pick(index)} onKeyDown={event => onKey(event, index)}>
              <span className="hc-swatch__door" data-accent-swatch={option.id} aria-hidden="true">{chosen && <Icon name="check" />}</span>
              <span className="hc-swatch__name">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function About() {
  const identity = useIdentity();
  const [server, setServer] = useState<string>();
  const [known, setKnown] = useState(false);
  useEffect(() => { void identity.serverVersion().then(version => { setServer(version); setKnown(true); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ul className="hc-results" data-testid="screen-about">
      <li className="hc-pair"><span>{copy.profile.clientVersion}</span><strong data-testid="client-version">{CLIENT_VERSION}</strong></li>
      <li className="hc-pair"><span>{copy.profile.serverVersion}</span><strong data-testid="server-version">{known ? server ?? copy.profile.versionUnknown : copy.common.loading}</strong></li>
      {identity.capabilities.filter(capability => capability.id in copy.capabilities).map(capability => (
        <li key={capability.id} className="hc-pair">
          <span>{copy.capabilities[capability.id]}</span>
          <strong>{capability.available ? copy.settings.available : copy.settings.unavailable}</strong>
        </li>
      ))}
    </ul>
  );
}
