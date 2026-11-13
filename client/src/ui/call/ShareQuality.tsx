import { useCall } from "../../core/context";
import { SHARE_QUALITIES } from "../../transport/shareQuality";
import { copy } from "../copy";
import { Button } from "../kit";
import { Sheet } from "../Sheet";

/**
 * Screen share quality: Smooth, Sharp or Source. Open it before a share to choose how the next one
 * goes out, or during one to change it live. Built on the shared sheet (HC-040 has no picker of
 * its own for this; it is the same two-way choice as "Create channel", with three options).
 */
export function ShareQualitySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const call = useCall();
  const words = copy.call.shareQualities[call.shareQuality];
  return (
    <Sheet open={open} onClose={onClose} title={copy.call.shareQuality} testId="share-quality"
      actions={<Button kind="primary" onClick={onClose}>{copy.common.done}</Button>}>
      <fieldset className="hc-seg" aria-label={copy.call.shareQuality}>
        {SHARE_QUALITIES.map(quality => (
          <label key={quality}>
            <input type="radio" name="share-quality" value={quality} checked={call.shareQuality === quality} onChange={() => void call.setShareQuality(quality)} />
            {copy.call.shareQualities[quality].name}
          </label>
        ))}
      </fieldset>
      <p className="hc-muted" role="status" data-testid="share-quality-hint">{words.hint}</p>
      <p className="hc-muted">{call.sharing ? copy.call.shareQualityLive : copy.call.shareQualityNext}</p>
    </Sheet>
  );
}
