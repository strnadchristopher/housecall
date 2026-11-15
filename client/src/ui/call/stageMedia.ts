import type { CallMedia } from "../../core/call";

/** The reserved screen-audio receiver exists even when no screen is being shared.
 * Only the publisher's explicit sharing state moves its video into a stream tile.
 * Each receiver belongs to exactly one tile so audio is never played twice. */
export function splitStageMedia(media: CallMedia[], sharing: boolean) {
  return {
    person: media.filter(item => !sharing || !item.share && !item.video),
    stream: sharing ? media.filter(item => item.share || item.video) : [],
  };
}
