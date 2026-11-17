import { NavContext } from "./nav";
import { useHosted } from "../../hosted/HostedAccount";
import { useContext, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useChat, useIdentity } from "../../core/context";
import { Logo } from "../brand/Logo";
import { copy } from "../copy";
import { Avatar, Button, ErrorLine, Field, Icon, cx } from "../kit";
import { CreateServerDialog } from "../setup/CreateServerDialog";
import { useDismiss } from "../useDismiss";

/**
 * The server picker. The list stays mounted and is moved with transform and
 * opacity only, so a click mid-animation reverses it from where it is.
 * Up, Down, Home, End, Enter, Escape and type-ahead work; focus returns to
 * the trigger on close. "Add server" takes an invite code or link (and, in the app, a server address);
 * a code for this host joins straight away.
 */
export function ServerPicker() {
  const hosted = useHosted();
  const nav = useContext(NavContext);
  const chat = useChat();
  const identity = useIdentity();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [addError, setAddError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const current = chat.servers.find(server => server.current);
  const manyHosts = new Set(chat.servers.map(server => server.host)).size > 1;
  const [creating, setCreating] = useState(false);
  const saved = hosted?.account.list?.servers.filter(origin => !hosted.hosts.hosts.some(host => host.origin === new URL(origin).origin && hosted.hosts.directory.get()[host.id]?.signedIn)) ?? [];
  const addRow = chat.servers.length + saved.length;
  const discoverRow = hosted ? addRow + 1 : -1;
  const createRow = identity.owner ? addRow + 1 + (hosted ? 1 : 0) : -1;
  const rows = addRow + 1 + (hosted ? 1 : 0) + (identity.owner ? 1 : 0);

  const close = (refocus = true) => {
    setOpen(false); setAdding(false); setAddError("");
    if (refocus) trigger.current?.focus();
  };
  const toggle = () => {
    if (open) return close();
    setIndex(Math.max(0, chat.servers.findIndex(server => server.current)));
    setOpen(true);
  };
  useEffect(() => {
    if (open && !adding) list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  }, [open, index, adding]);
  // Escape is handled by onKey below (it refocuses the trigger); an outside press just closes.
  useDismiss(open, () => close(false), target => !!list.current?.contains(target) || !!trigger.current?.contains(target), { escape: false });

  const choose = (at: number) => {
    if (at === discoverRow) { close(); nav?.set({ main: 'chat', screen: 'main' }); hosted?.go('discover'); return; }
    const savedOrigin = saved[at - chat.servers.length];
    if (savedOrigin) { close(); hosted?.go('home'); hosted?.hosts.add(savedOrigin); return; }
    const server = chat.servers[at];
    if (at === createRow) { close(); setCreating(true); return; }
    if (!server) { setAdding(true); return; }
    close();
    hosted?.go('home');
    if (!server.current) void chat.selectServer(server.key);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (adding) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex(value => (value + 1) % rows); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex(value => (value - 1 + rows) % rows); }
    else if (event.key === "Home") { event.preventDefault(); setIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setIndex(rows - 1); }
    else if (event.key === "Tab") close(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const found = chat.servers.findIndex(server => server.name.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) setIndex(found);
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    try { identity.addServer(input); setInput(""); close(false); }
    catch (error) { setAddError(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <div className="hc-picker" data-open={open ? "" : undefined} onKeyDown={onKey}>
      <button ref={trigger} type="button" className="hc-picker__trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
        aria-label={`${copy.picker.label}: ${current?.name ?? identity.serverName}`}
        onClick={toggle} onKeyDown={event => { if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); event.stopPropagation(); toggle(); } }}>
        {current?.iconUrl ? <Avatar name={current.name} src={current.iconUrl} shape="squircle" /> : <Logo open={open} label="" />}
        <span className="hc-picker__name">
          <strong>{current?.name ?? hosted?.account.name ?? identity.serverName}</strong>
          {chat.servers.length > 0 && <small data-state={chat.online ? "on" : "off"}>{chat.online ? copy.state.connected : copy.state.reconnecting}</small>}
        </span>
        <span className="hc-picker__chev"><Icon name="down" /></span>
      </button>
      <div ref={list} id={id} className="hc-picker__list" role="listbox" aria-label={copy.picker.label} inert={!open}>
        {chat.servers.map((server, at) => (
          <button key={server.key} type="button" role="option" aria-selected={server.current} data-index={at} tabIndex={at === index ? 0 : -1}
            className={cx("hc-picker__row", server.current && "is-current")} style={{ ["--i" as string]: at }} onClick={() => choose(at)}>
            <Avatar name={server.name} src={server.iconUrl} size="sm" shape="squircle" />
            <span className="hc-picker__rowname">
              <strong>{server.name}</strong>
              <small>{manyHosts ? `${server.host} · ` : ""}{server.status === "connected" ? copy.state.connected : copy.state.reconnecting}</small>
            </span>
            {server.mentions > 0 && <span className="hc-dot" role="img" aria-label={copy.picker.mentions(server.mentions)} />}
          </button>
        ))}
        {saved.map((origin, i) => <button key={origin} type="button" role="option" aria-selected={false} data-index={chat.servers.length + i} tabIndex={index === chat.servers.length + i ? 0 : -1} className="hc-picker__row" onClick={() => choose(chat.servers.length + i)}><span className="hc-picker__rowname"><strong>{new URL(origin).host}</strong><small>Log in needed</small></span></button>)}
        {hosted && !adding && <button type="button" role="option" aria-selected={false} data-index={discoverRow} tabIndex={index === discoverRow ? 0 : -1} className="hc-picker__row" onClick={() => choose(discoverRow)}>Discover servers</button>}
        {!adding && (
          <button type="button" role="option" aria-selected={false} data-index={addRow} tabIndex={index === addRow ? 0 : -1}
            className="hc-picker__row hc-picker__add" style={{ ["--i" as string]: addRow }} onClick={() => choose(addRow)}>
            <Icon name="plus" /><strong>{copy.picker.add}</strong>
          </button>
        )}
        {identity.owner && !adding && (
          <button type="button" role="option" aria-selected={false} data-index={createRow} tabIndex={index === createRow ? 0 : -1}
            className="hc-picker__row hc-picker__add" style={{ ["--i" as string]: createRow }} onClick={() => choose(createRow)}>
            <Icon name="plus" /><strong>{copy.picker.create}</strong>
          </button>
        )}
        {adding && (
          <form className="hc-picker__form" onSubmit={add}>
            <Field label={identity.native || hosted ? copy.onboarding.addressOrLink : copy.onboarding.inviteCodeOrLink} value={input} onChange={event => setInput(event.target.value)} autoFocus autoCapitalize="none" required />
            <ErrorLine text={addError} />
            <Button kind="primary" type="submit">{copy.onboarding.connect}</Button>
          </form>
        )}
      </div>
      <CreateServerDialog open={creating} onClose={() => { setCreating(false); trigger.current?.focus(); }} />
    </div>
  );
}
