import { canControlLocalAudio } from "../../core/call";
import { useState } from "react";
import { useCall } from "../../core/context";
import { copy } from "../copy";
import { usePhone } from "../tokens/motion";
import { IconButton } from "../kit";
import { ShareQualitySheet } from "./ShareQuality";

/** Mute, deafen, camera, screen share, leave. Shared by the call bar and the dock. */
export function CallControls({ stage = false }: { stage?: boolean }) {
  const call = useCall();
  const phone = usePhone();
  const live = call.phase === "live";
  const [quality, setQuality] = useState(false);
  return (
    <div className={stage ? "hc-stagebar" : "hc-callctl"} data-testid={stage ? "call-bar" : undefined} data-stage-bar={stage ? "" : undefined} data-phase={call.phase} role="toolbar" aria-label={copy.call.label}>
      <IconButton icon="mic" off={call.muted} active={call.muted} aria-pressed={call.muted} disabled={!canControlLocalAudio(call)} label={call.muted ? copy.call.unmute : copy.call.mute} onClick={() => call.setMuted(!call.muted)} />
      <IconButton icon="headphones" off={call.deafened} active={call.deafened} aria-pressed={call.deafened} disabled={!canControlLocalAudio(call)} label={call.deafened ? copy.call.undeafen : copy.call.deafen} onClick={() => call.setDeafened(!call.deafened)} />
      <IconButton icon="camera" off={!call.camera} className={call.camera ? "is-lit" : undefined} aria-pressed={call.camera} disabled={!live} label={call.camera ? copy.call.cameraOff : copy.call.cameraOn} onClick={() => void call.setCamera(!call.camera)} />
      {!phone && <IconButton icon="screen" className={call.sharing ? "is-lit" : undefined} aria-pressed={call.sharing} disabled={!live} label={call.sharing ? copy.call.stopShare : copy.call.share} onClick={() => void call.setSharing(!call.sharing)} onContextMenu={event => { event.preventDefault(); setQuality(true); }} />}
      {!stage && <IconButton icon="settings" disabled={!live} label={copy.call.shareQuality} onClick={() => setQuality(true)} />}
      <IconButton icon="leave" className={stage ? "hc-stagebar__leave" : "hc-ibtn--danger"} label={copy.call.leave} onClick={() => void call.leave()} />
      <ShareQualitySheet open={quality} onClose={() => setQuality(false)} />
    </div>
  );
}
