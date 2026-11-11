import { useEffect, useRef, type KeyboardEvent } from "react";
import { copy } from "../copy";

const EMOJI = [
  "👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "👀", "✅", "😀", "😅", "🙂", "😉", "😍", "😎", "🤔", "😴", "😭", "😡",
  "🥳", "🤝", "👏", "🙌", "💪", "👋", "🤷", "🤦", "💯", "⭐", "☕", "🍕", "🎬", "🎵", "🎮", "📞", "📎", "💡", "🚀", "🌧️",
];

/**
 * A small fixed set, used by the composer and by message reactions. Plain
 * buttons in a group: focus moves to the first on open, Escape closes and
 * returns focus to where it came from.
 */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = group.current;
    node?.querySelector("button")?.focus();
    // Unmounting waits for the exit animation, so only take focus back if nothing else has it by then.
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || node?.contains(active))) opener.focus();
    };
  }, []);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div ref={group} className="hc-emoji hc-anim-pop" role="group" aria-label={copy.composer.emoji} onKeyDown={onKey}>
      {EMOJI.map(emoji => (
        <button key={emoji} type="button" aria-label={emoji} onClick={() => onPick(emoji)}>{emoji}</button>
      ))}
    </div>
  );
}
