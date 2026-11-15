import { type ButtonHTMLAttributes } from "react";
import { copy } from "../copy";
import { cx } from "../kit";
import { useEntrance } from "../tokens/motion";

/** A LIVE mark arrives once; changing the motion preference later must not replay it. */
export function LivePill({ button = false, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { button?: boolean }) {
  const [entering, finish] = useEntrance(320);
  const classes = cx("hc-livepill", entering && "is-entering", className);
  if (button) return <button type="button" {...props} className={classes} onAnimationEnd={finish}>{copy.voice.live}</button>;
  return <span className={classes} onAnimationEnd={finish}>{copy.voice.live}</span>;
}
