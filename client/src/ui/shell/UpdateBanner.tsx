import { useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Button } from "../kit";

/** Desktop self-update state: downloading, ready to restart, or failed. */
export function UpdateBanner() {
  const identity = useIdentity();
  const update = identity.update;
  if (!update) return null;
  return (
    <div className="hc-update" role="status">
      <span>
        {update.kind === "downloading" ? copy.update.downloading(update.version, update.percent)
          : update.kind === "failed" ? copy.update.failed(update.version) : copy.update.ready(update.version)}
      </span>
      {update.kind === "ready" && <Button kind="text" onClick={identity.dismissUpdate}>{copy.update.later}</Button>}
      {(update.kind === "ready" || update.kind === "installing") && (
        <Button kind="primary" busy={update.kind === "installing"} onClick={() => void identity.restartToUpdate()}>{copy.update.restart}</Button>
      )}
      {update.kind === "failed" && <Button kind="text" onClick={identity.dismissUpdate}>{copy.common.dismiss}</Button>}
    </div>
  );
}
