import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChat } from "../../core/context";
import type { VoiceRoomMember } from "../../core/call";
import { copy } from "../copy";
import { Avatar, Button, Icon, Presence } from "../kit";
import { Sheet } from "../Sheet";
import { useDismiss } from "../useDismiss";
import { usePhone } from "../tokens/motion";

export interface PreviewTarget {
  channelId: string;
  member: VoiceRoomMember;
  /** The LIVE mark that opened it; undefined when opened from the row itself. */
  anchor?: HTMLElement;
  /** Opened by a click or a tap: stays until dismissed. Otherwise it follows the pointer. */
  pinned?: boolean;
}

const REFRESH_MS = 15000;

/** The newest picture of someone's stream, refetched while shown. The old blob is revoked only after the new one is up. */
function usePicture(channelId: string, personId: string, active: boolean): { state: "loading" | "picture" | "none"; url?: string } {
  const chat = useChat();
  const [shown, setShown] = useState<{ state: "loading" | "picture" | "none"; url?: string }>({ state: "loading" });
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const load = async () => {
      try {
        const blob = await chat.fetchMedia(`/api/channels/${encodeURIComponent(channelId)}/voice/preview/${encodeURIComponent(personId)}`);
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        const old = current.current;
        current.current = url;
        setShown({ state: "picture", url });
        if (old) setTimeout(() => URL.revokeObjectURL(old), 200);
      } catch {
        if (!stopped) setShown(previous => previous.state === "picture" ? previous : { state: "none" });
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [channelId, personId, active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current); current.current = undefined; }, []);
  return shown;
}

function Body({ target, channelName }: { target: PreviewTarget; channelName: string }) {
  const picture = usePicture(target.channelId, target.member.personId, true);
  const name = target.member.name;
  return (
    <>
      <div className="hc-preview-pop__frame" data-state={picture.state}>
        {picture.state === "picture" && <img src={picture.url ?? ""} alt={copy.voice.previewAlt(name)} />}
        {picture.state === "loading" && <span className="hc-skel" style={{ position: "absolute", inset: 0, borderRadius: 0 }} />}
        {picture.state === "none" && <span className="hc-preview-pop__none"><Icon name="screen" />{copy.voice.noPreview}</span>}
        <span className="hc-livepill" aria-hidden="true">{copy.voice.live}</span>
      </div>
      <div className="hc-preview-pop__who">
        <Avatar name={name} src={target.member.avatarUrl} size="sm" />
        <span><strong>{name}</strong><small>{copy.voice.sharingIn(channelName)}</small></span>
      </div>
    </>
  );
}

/** HC-040 section 4.2: a popover beside the sidebar on wide screens, a sheet on phones. */
export function StreamPreview({ target, onClose, onOpenCall }: { target?: PreviewTarget; onClose: () => void; onOpenCall: (channelId: string, personId: string) => void }) {
  const chat = useChat();
  const phone = usePhone();
  const pop = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => setPinned(!!target?.pinned || !target?.anchor), [target]);
  // The stream ends: the mark and the popover leave together.
  const live = !target || target.member.sharing;
  useEffect(() => { if (target && !live) onClose(); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  useDismiss(!!target && !phone, onClose, element => !!pop.current?.contains(element) || !!target?.anchor?.contains(element));
  // Hover opens it, so it also follows the pointer: gone 120 ms after the pointer leaves both the mark and the popover.
  useEffect(() => {
    if (!target || pinned || phone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const move = (event: PointerEvent) => {
      const over = event.target instanceof Node && (!!pop.current?.contains(event.target) || !!target.anchor?.contains(event.target));
      clearTimeout(timer);
      if (!over) timer = setTimeout(onClose, 120);
    };
    document.addEventListener("pointermove", move);
    return () => { document.removeEventListener("pointermove", move); clearTimeout(timer); };
  }, [target, pinned, phone]); // eslint-disable-line react-hooks/exhaustive-deps
  const [last, setLast] = useState<PreviewTarget>();
  useEffect(() => { if (target) setLast(target); }, [target]);
  const shown = target ?? last;
  if (!shown) return null;
  const channelName = chat.conversations.find(conversation => conversation.id === shown.channelId)?.name ?? "";
  const watch = () => { onClose(); onOpenCall(shown.channelId, shown.member.personId); };
  if (phone) {
    return (
      <Sheet open={!!target} onClose={onClose} title={copy.voice.streamOf(shown.member.name)} testId="stream-preview"
        actions={<Button kind="primary" onClick={watch}>{copy.voice.watch}</Button>}>
        <div className="hc-preview-pop"><Body target={shown} channelName={channelName} /></div>
      </Sheet>
    );
  }
  const rect = shown.anchor?.getBoundingClientRect();
  const column = document.querySelector(".hc-left")?.getBoundingClientRect();
  const left = (column?.right ?? 240) - 4;
  const top = Math.max(8, Math.min((rect?.top ?? 120) - 24, window.innerHeight - 260 - 8));
  return createPortal(
    <Presence show={!!target} ms={110}>
      <div ref={pop} className="hc-popover hc-preview-pop hc-anim-pop" role="dialog" aria-label={copy.voice.streamOf(shown.member.name)} data-testid="stream-preview"
        style={{ position: "fixed", left, top }}>
        <Body target={shown} channelName={channelName} />
        <Button kind="primary" onClick={watch}>{copy.voice.watch}</Button>
      </div>
    </Presence>,
    document.body,
  );
}
