import { useCall } from "../../core/context";
import { copy } from "../copy";
import { IconButton } from "../kit";

/** Mute, deafen, camera, screen share, leave. Shared by the call bar and the dock. */
export function CallControls() {
  const call = useCall();
  const live = call.phase === "live";
  return (
    <div className="hc-callctl" role="toolbar" aria-label={copy.call.label}>
      <IconButton icon="mic" off={call.muted} active={call.muted} disabled={!live} label={call.muted ? copy.call.unmute : copy.call.mute} onClick={() => call.setMuted(!call.muted)} />
      <IconButton icon="headphones" off={call.deafened} active={call.deafened} disabled={!live} label={call.deafened ? copy.call.undeafen : copy.call.deafen} onClick={() => call.setDeafened(!call.deafened)} />
      <IconButton icon="camera" off={!call.camera} active={call.camera} disabled={!live} label={call.camera ? copy.call.cameraOff : copy.call.cameraOn} onClick={() => void call.setCamera(!call.camera)} />
      <IconButton icon="screen" active={call.sharing} disabled={!live} label={call.sharing ? copy.call.stopShare : copy.call.share} onClick={() => void call.setSharing(!call.sharing)} />
      <IconButton icon="leave" className="hc-ibtn--danger" label={copy.call.leave} onClick={() => void call.leave()} />
    </div>
  );
}
