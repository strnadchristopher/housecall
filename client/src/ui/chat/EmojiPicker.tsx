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
    group.current?.querySelector("button")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div ref={group} className="hc-emoji" role="group" aria-label={copy.composer.emoji} onKeyDown={onKey}>
      {EMOJI.map(emoji => (
        <button key={emoji} type="button" aria-label={emoji} onClick={() => onPick(emoji)}>{emoji}</button>
      ))}
    </div>
  );
}
