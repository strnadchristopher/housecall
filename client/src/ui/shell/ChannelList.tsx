import { useEffect, useRef, useState, type FormEvent } from "react";
import { useCall, useChat, useIdentity } from "../../core/context";
import type { VoiceRoomMember } from "../../core/call";
import { copy } from "../copy";
import { Avatar, Button, ErrorLine, Field, Icon, IconButton, cx, type IconName } from "../kit";
import { Sheet } from "../Sheet";
import { useFlip, usePhone } from "../tokens/motion";
import { StreamPreview, type PreviewTarget } from "../call/StreamPreview";
import { useNav } from "./nav";

const LEAVE_MS = 110;

/** A mouse resting on the LIVE mark for 250 ms opens the preview; touch uses the tap. */
function hover(event: React.PointerEvent<HTMLElement>, open?: (target: HTMLElement, pinned: boolean) => void) {
  if (event.pointerType !== "mouse" || !open) return;
  const target = event.currentTarget;
  const timer = setTimeout(() => open(target, false), 250);
  const stop = () => clearTimeout(timer);
  for (const type of ["pointerleave", "pointerdown", "focus"]) target.addEventListener(type, stop, { once: true });
}

/** Words for what a person is doing, in order: live, camera, then one audio state (deafen covers mute). */
export function stateWords(member: Pick<VoiceRoomMember, "sharing" | "camera" | "muted" | "deafened">): string[] {
  return [
    ...(member.sharing ? [copy.voice.words.live] : []),
    ...(member.camera ? [copy.voice.words.cameraOn] : []),
    ...(member.deafened ? [copy.voice.words.deafened] : member.muted ? [copy.voice.words.muted] : []),
  ];
}

/** The state icons of one person: LIVE mark (a button), camera, then one audio icon. */
export function StateIcons({ member, name, onLive }: { member: VoiceRoomMember; name: string; onLive?: (target: HTMLElement, pinned: boolean) => void }) {
  return (
    <span className="hc-vrow__state">
      {member.sharing && <button type="button" className="hc-livepill" aria-label={copy.voice.livePreview(name)} onClick={event => onLive?.(event.currentTarget, true)} onFocus={event => event.currentTarget.matches(":focus-visible") && onLive?.(event.currentTarget, true)} onPointerEnter={event => hover(event, onLive)}>{copy.voice.live}</button>}
      {member.camera && <Icon name="camera" />}
      {member.deafened ? <Icon name="headphones" off /> : member.muted ? <Icon name="mic" off /> : null}
    </span>
  );
}

/** Keeps a person who just left in the list for one exit animation, and marks who just arrived. */
function useRows(members: VoiceRoomMember[]) {
  const [rows, setRows] = useState(() => members.map(member => ({ member, leaving: false, entering: false })));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setRows(current => {
      const known = new Set(current.filter(row => !row.leaving).map(row => row.member.personId));
      const now = new Set(members.map(member => member.personId));
      const left = current.filter(row => !now.has(row.member.personId));
      const stay = members.map(member => ({ member, leaving: false, entering: !known.has(member.personId) }));
      const result = [...stay];
      for (const row of left) result.splice(Math.min(current.indexOf(row), result.length), 0, { member: row.member, leaving: true, entering: false });
      return result;
    });
    const timer = setTimeout(() => setRows(current => current.filter(row => !row.leaving)), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [members]);
  return rows;
}

function People({ channelName, members, meId, onLive, onOpen }: {
  channelName: string; members: VoiceRoomMember[]; meId: string; onLive: (member: VoiceRoomMember, anchor: HTMLElement, pinned: boolean) => void; onOpen: (member: VoiceRoomMember) => void;
}) {
  const call = useCall();
  const rows = useRows(members);
  const list = useRef<HTMLUListElement>(null);
  useFlip(list, members.map(member => member.personId).join());
  return (
    <ul ref={list} className="hc-voice__people" aria-label={copy.channels.peopleIn(channelName)}>
      {rows.map(({ member, leaving, entering }) => {
        const speaking = call.speaking.includes(member.personId);
        return (
          <li key={member.personId} data-flip={member.personId} data-testid="voice-person"
            className={cx("hc-vrow", speaking && "is-speaking", member.personId === meId && "is-me", entering && "is-entering", leaving && "is-leaving")}>
            <button type="button" className="hc-vrow__open" aria-label={copy.voice.rowLabel(member.name, stateWords(member))} onClick={() => onOpen(member)} />
            <span className={cx("hc-face", speaking && "is-speaking")}><Avatar name={member.name} src={member.avatarUrl} size="xs" /></span>
            <span className="hc-vrow__name">{member.name}</span>
            <StateIcons member={member} name={member.name} onLive={(anchor, pinned) => onLive(member, anchor, pinned)} />
          </li>
        );
      })}
    </ul>
  );
}

function CreateChannel({ kind, onClose }: { kind: "channel" | "voice" | null; onClose: () => void }) {
  const chat = useChat();
  const identity = useIdentity();
  const [chosen, setChosen] = useState<"channel" | "voice">("channel");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const open = kind !== null;
  useEffect(() => { if (kind) { setChosen(kind); setName(""); setError(""); } }, [kind]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (await chat.createChannel(name.trim(), [], chosen)) onClose();
    else setError(chat.error || copy.common.retry);
  };
  return (
    <Sheet open={open} onClose={onClose} title={copy.channels.create} testId="create-channel"
      actions={<>
        <Button kind="primary" type="submit" form="hc-create-channel" busy={chat.busy} disabled={!name.trim()}>{copy.channels.create}</Button>
        <Button kind="text" onClick={onClose}>{copy.common.cancel}</Button>
      </>}>
      <form id="hc-create-channel" className="hc-stack" onSubmit={event => void submit(event)}>
        <fieldset className="hc-seg" aria-label={copy.channels.kind}>
          <label><input type="radio" name="kind" checked={chosen === "channel"} onChange={() => setChosen("channel")} /><Icon name="hash" />{copy.channels.kindText}</label>
          <label><input type="radio" name="kind" checked={chosen === "voice"} onChange={() => setChosen("voice")} /><Icon name="speaker" />{copy.channels.kindVoice}</label>
        </fieldset>
        <Field label={copy.settings.channelName} value={name} onChange={event => setName(event.target.value)} maxLength={48} />
        <p className="hc-note"><Icon name="info" /><span>{chosen === "voice" ? copy.channels.noteVoice(identity.serverName) : copy.channels.noteText(identity.serverName)}</span></p>
        <ErrorLine text={error} onDismiss={() => setError("")} dismissLabel={copy.common.dismiss} />
      </form>
    </Sheet>
  );
}

function Group({ id, label, add, addLabel, onAdd, children, listRef }: { listRef?: React.RefObject<HTMLUListElement | null>; id: string; label: string; add: boolean; addLabel: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <section className="hc-group" aria-labelledby={id}>
      <div className="hc-group__head">
        <h2 className="hc-group__label" id={id}>{label}</h2>
        {add && <button type="button" className="hc-group__add" aria-label={addLabel} onClick={onAdd}><Icon name="plus" /></button>}
      </div>
      <ul ref={listRef} className="hc-group__list">{children}</ul>
    </section>
  );
}

/** Text channels and voice channels as two lists. A voice channel shows who is inside before you go in. */
export function ChannelList() {
  const chat = useChat();
  const call = useCall();
  const nav = useNav();
  const phone = usePhone();
  const [creating, setCreating] = useState<"channel" | "voice" | null>(null);
  const [sheet, setSheet] = useState<string>();
  const [switching, setSwitching] = useState<string>();
  const [preview, setPreview] = useState<PreviewTarget>();
  const voiceList = useRef<HTMLUListElement>(null);
  const text = chat.conversations.filter(conversation => conversation.kind === "channel");
  const voice = chat.conversations.filter(conversation => conversation.kind === "voice");
  const inside = (id: string) => call.phase !== "idle" && call.conversationId === id;
  const membersOf = (id: string): VoiceRoomMember[] => call.rooms[id] ?? [];
  useFlip(voiceList, voice.map(channel => channel.id + ":" + membersOf(channel.id).map(member => member.personId + Number(member.sharing)).join()).join("|"));

  const enter = (id: string) => { nav.set({ main: "chat", screen: "main" }); void chat.open(id); };
  const join = (id: string) => {
    enter(id);
    if (!call.available || inside(id)) return;
    const elsewhere = call.phase !== "idle" ? chat.conversations.find(conversation => conversation.id === call.conversationId) : undefined;
    if (elsewhere && elsewhere.kind !== "voice") { setSwitching(id); return; }
    void call.join(id);
  };
  const open = (channel: { id: string }) => {
    if (phone && !inside(channel.id)) { setSheet(channel.id); return; }
    join(channel.id);
  };
  const sheetChannel = voice.find(channel => channel.id === sheet);
  const switchTo = chat.conversations.find(conversation => conversation.id === switching);
  const elsewhereName = call.conversationName ?? "";

  return (
    <div className="hc-channels">
      <Group id="hc-g-text" label={copy.channels.text} add={chat.can.createChannel} addLabel={copy.channels.createText} onAdd={() => setCreating("channel")}>
        {text.map(channel => {
          const here = channel.id === chat.current?.id;
          return (
            <li key={channel.id}>
              <div className={cx("hc-channel", here && "is-current", channel.mentions > 0 && "is-unread")}>
                <button type="button" className="hc-channel__open" aria-current={here ? "page" : undefined} aria-label={copy.channels.open(channel.name)}
                  onClick={() => { nav.set({ main: "chat", screen: "main" }); if (!here) void chat.open(channel.id); }} />
                <span className="hc-channel__glyph"><Icon name="hash" /></span>
                <span className="hc-channel__name">{channel.name}</span>
                {channel.mentions > 0 && <span className="hc-count" aria-label={copy.channels.mentions(channel.mentions)}>{channel.mentions}</span>}
              </div>
            </li>
          );
        })}
      </Group>
      <Group listRef={voiceList} id="hc-g-voice" label={copy.channels.voice} add={chat.can.createChannel} addLabel={copy.channels.createVoice} onAdd={() => setCreating("voice")}>
        {voice.map(channel => {
          const here = channel.id === chat.current?.id;
          const members = membersOf(channel.id);
          const joined = inside(channel.id);
          return (
            <li key={channel.id} data-flip={channel.id} data-testid="voice-channel">
              <div className={cx("hc-channel", members.length > 0 && "is-lit", joined && "is-joined", here && "is-current", channel.mentions > 0 && "is-unread")}>
                <button type="button" className="hc-channel__open" aria-current={here ? "page" : undefined} aria-label={copy.channels.open(channel.name)} onClick={() => open(channel)} />
                <span className="hc-channel__glyph"><Icon name="speaker" /></span>
                <span className="hc-channel__name">{channel.name}</span>
                <span className="hc-channel__side">
                  <IconButton icon={"chat" as IconName} label={copy.channels.chatIn(channel.name)}
                    onClick={() => { enter(channel.id); nav.set({ side: { kind: "tabs", tab: "chat" }, sheet: true }); }} />
                </span>
                {members.length > 0 && <span className="hc-channel__n" aria-label={copy.channels.inside(members.length)}>{members.length}</span>}
              </div>
              {members.length > 0 && (
                <People channelName={channel.name} members={members} meId={chat.me.id}
                  onLive={(member, anchor, pinned) => setPreview({ channelId: channel.id, member, anchor, pinned })}
                  onOpen={member => (phone ? open(channel) : member.sharing ? setPreview({ channelId: channel.id, member, anchor: undefined }) : enter(channel.id))} />
              )}
            </li>
          );
        })}
      </Group>
      <CreateChannel kind={creating} onClose={() => setCreating(null)} />
      <Sheet open={!!sheetChannel} onClose={() => setSheet(undefined)} title={sheetChannel?.name ?? ""} testId="voice-sheet"
        actions={sheetChannel && (inside(sheetChannel.id)
          ? <><Button kind="primary" onClick={() => { enter(sheetChannel.id); setSheet(undefined); }}>{copy.voice.openCall}</Button>
              <Button kind="text" className="hc-btn--danger-text" onClick={() => { void call.leave(); setSheet(undefined); }}>{copy.voice.leave}</Button></>
          : <Button kind="primary" onClick={() => { join(sheetChannel.id); setSheet(undefined); }}>{copy.voice.join}</Button>)}>
        {sheetChannel && (membersOf(sheetChannel.id).length === 0
          ? <p className="hc-voicesheet__empty">{copy.voice.empty}</p>
          : (
            <ul className="hc-voicesheet__people">
              {membersOf(sheetChannel.id).map(member => (
                <li key={member.personId} className="hc-voicesheet__row">
                  <span className={cx("hc-face", call.speaking.includes(member.personId) && "is-speaking")}><Avatar name={member.name} src={member.avatarUrl} size="md" /></span>
                  <span><strong>{member.name}</strong><small className="hc-muted">{member.sharing ? copy.voice.state.sharing : member.camera ? copy.voice.state.camera : member.deafened ? copy.voice.state.deafened : member.muted ? copy.voice.state.muted : ""}</small></span>
                  <StateIcons member={member} name={member.name} onLive={(anchor, pinned) => setPreview({ channelId: sheetChannel.id, member, anchor, pinned })} />
                </li>
              ))}
            </ul>
          ))}
      </Sheet>
      <Sheet open={!!switchTo} onClose={() => setSwitching(undefined)} title={copy.voice.switchTitle(elsewhereName)} testId="switch-call"
        actions={switchTo && <><Button kind="primary" onClick={() => { const id = switchTo.id; setSwitching(undefined); void call.join(id); }}>{copy.voice.switchJoin(switchTo.name)}</Button>
          <Button kind="text" onClick={() => setSwitching(undefined)}>{copy.voice.stay}</Button></>} />
      <StreamPreview target={preview} onClose={() => setPreview(undefined)} onOpenCall={id => { enter(id); join(id); }} />
    </div>
  );
}
