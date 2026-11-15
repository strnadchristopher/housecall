import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCall, useChat } from "../../core/context";
import { personPrefs, readPrefs, setPersonPrefs, subscribePrefs } from "../../state/audioOutput";
import { copy } from "../copy";
import { Avatar, Button, ErrorLine } from "../kit";
import { Sheet } from "../Sheet";
import { useNav } from "../shell/nav";
import { usePhone } from "../tokens/motion";
import { personCardPosition } from "./position";

type Target = { id: string; anchor: HTMLElement; name?: string; avatarUrl?: string };
const PersonContext = createContext<(target: Target) => void>(() => {});
export const usePersonCard = () => useContext(PersonContext);

/** One shared person surface for sidebar rows, People, and tile captions. */
export function PersonCards({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target>();
  return <PersonContext.Provider value={target => { target.anchor.focus({ preventScroll: true }); setTarget(target); }}>{children}{target && <PersonCard target={target} onClose={() => setTarget(undefined)} />}</PersonContext.Provider>;
}

function PersonCard({ target, onClose }: { target: Target; onClose: () => void }) {
  const chat = useChat(), call = useCall(), nav = useNav(), phone = usePhone();
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const person = target.id === chat.me.id ? chat.me : [...chat.people, ...chat.friends].find(person => person.id === target.id);
  const name = person?.name ?? target.name ?? "";
  const own = target.id === chat.me.id;
  const room = Object.entries(call.rooms).find(([, members]) => members.some(member => member.personId === target.id));
  const channel = room && chat.conversations.find(conversation => conversation.id === room[0]);
  const inCall = !own && call.phase !== "idle" && call.phase !== "failed" && (!!call.participants.find(person => person.personId === target.id) || !!call.conversationId && !!call.rooms[call.conversationId]?.some(member => member.personId === target.id));
  useSyncExternalStore(subscribePrefs, () => localStorage.getItem("hc.voicePrefs") ?? "", () => "");
  const prefs = personPrefs(readPrefs(), target.id);
  useLayoutEffect(() => {
    if (phone) return;
    const element = card.current;
    if (!element) return;
    const measure = () => setPosition(personCardPosition(target.anchor.getBoundingClientRect(), element.getBoundingClientRect().height, innerWidth, innerHeight, !!target.anchor.closest(".hc-right")));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    window.addEventListener("resize", measure);
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !element.contains(event.target) && !target.anchor.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", key, true);
    element.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); document.removeEventListener("click", outside, true); document.removeEventListener("keydown", key, true); if (target.anchor.isConnected) target.anchor.focus({ preventScroll: true }); };
  }, [target, phone]);
  // Sheet owns its focus trap; the explicit anchor also covers pointer browsers that do not focus buttons on tap.
  const close = () => { onClose(); target.anchor.focus({ preventScroll: true }); };
  const message = async () => {
    setBusy(true); setError("");
    try {
      if (await chat.startDirect([target.id], "")) { close(); nav.set({ main: "chat", screen: "main", sheet: false, left: "dm" }); }
      else setError(copy.common.retry);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.common.retry); }
    finally { setBusy(false); }
  };
  const body = <>
    <div className="hc-personcard__top"><Avatar name={name} src={person?.avatarUrl ?? target.avatarUrl} size="lg" /><span><strong>{name}</strong><small className="hc-muted">{person?.owner ? copy.side.owner : copy.people.member}{channel && ` · ${copy.people.inChannel(channel.name)}`}</small></span></div>
    {person?.bio && <p className="hc-personcard__bio">{person.bio}</p>}
    {inCall && <>
      <label className="hc-personcard__vol">{copy.people.volume}<input type="range" min={0} max={100} value={Math.round(prefs.volume * 100)} onChange={event => setPersonPrefs(target.id, { volume: Number(event.target.value) / 100 })} /></label>
      <label className="hc-check hc-switchrow"><span>{copy.people.muteForMe}</span><input type="checkbox" role="switch" checked={prefs.muted} onChange={event => setPersonPrefs(target.id, { muted: event.target.checked })} /></label>
    </>}
    {own ? <Button kind="text" onClick={() => { close(); nav.set({ main: "settings", section: "account", screen: "main", sheet: false }); }}>{copy.profile.edit}</Button> : <div className="hc-personcard__actions">
      <Button kind="primary" busy={busy} onClick={() => void message()}>{copy.people.message}</Button>
      {call.available && <Button disabled={busy} onClick={() => { close(); nav.set({ main: "chat", screen: "main", sheet: false }); void call.callPerson(target.id); }}>{copy.people.call}</Button>}
    </div>}
    <ErrorLine text={error} />
  </>;
  if (phone) return <Sheet open onClose={close} title={name} testId="person-card"><div className="hc-personcard">{body}</div></Sheet>;
  return createPortal(<div ref={card} className="hc-popover hc-personcard hc-anim-pop" role="dialog" aria-label={name} data-testid="person-card" style={{ position: "fixed", ...position }}>{body}</div>, document.body);
}
