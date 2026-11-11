import { copy } from "../copy";

const EMOJI = [
  "👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "👀", "✅", "😀", "😅", "🙂", "😉", "😍", "😎", "🤔", "😴", "😭", "😡",
  "🥳", "🤝", "👏", "🙌", "💪", "👋", "🤷", "🤦", "💯", "⭐", "☕", "🍕", "🎬", "🎵", "🎮", "📞", "📎", "💡", "🚀", "🌧️",
];

/** A small fixed set, used by the composer and by message reactions. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="hc-emoji" role="listbox" aria-label={copy.composer.emoji}>
      {EMOJI.map(emoji => (
        <button key={emoji} type="button" role="option" aria-selected={false} aria-label={emoji} onClick={() => onPick(emoji)}>{emoji}</button>
      ))}
    </div>
  );
}
