import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useChat, useIdentity } from "../../core/context";
import { Logo } from "../brand/Logo";
import { copy } from "../copy";
import { createPortal } from "react-dom";
import { Avatar, Button, ErrorLine, Field, Icon, Presence, cx } from "../kit";
import { CreateServerWizard } from "../setup/CreateServerWizard";

/**
 * The server picker. The list stays mounted and is moved with transform and
 * opacity only, so a click mid-animation reverses it from where it is.
 * Up, Down, Home, End, Enter, Escape and type-ahead work; focus returns to
 * the trigger on close; "Add Server" is the last row on native builds.
 */
export function ServerPicker() {
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
  const addRow = identity.native ? chat.servers.length : -1;
  const createRow = identity.owner ? chat.servers.length + (identity.native ? 1 : 0) : -1;
  const rows = chat.servers.length + (identity.native ? 1 : 0) + (identity.owner ? 1 : 0);

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
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const choose = (at: number) => {
    const server = chat.servers[at];
    if (at === createRow) { close(); setCreating(true); return; }
    if (!server) { setAdding(true); return; }
    close();
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
          <strong>{current?.name ?? identity.serverName}</strong>
          <small data-state={chat.online ? "on" : "off"}>{chat.online ? copy.state.connected : copy.state.reconnecting}</small>
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
        {identity.native && !adding && (
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
        {identity.native && adding && (
          <form className="hc-picker__form" onSubmit={add}>
            <Field label={copy.onboarding.addressOrLink} value={input} onChange={event => setInput(event.target.value)} autoFocus autoCapitalize="none" required />
            <ErrorLine text={addError} />
            <Button kind="primary" type="submit">{copy.onboarding.connect}</Button>
          </form>
        )}
      </div>
      {createPortal(
        <Presence show={creating}><CreateServerWizard onClose={() => setCreating(false)} /></Presence>,
        document.body,
      )}
    </div>
  );
}
