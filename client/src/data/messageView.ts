import type { Message } from "../state/messages";

export interface MessageDetails {
  authorId: string; authorName: string; createdAt: number; editedAt?: number;
  replyTo?: { id: string; authorName: string; excerpt: string } | null;
  pinned: boolean; reactions: { emoji: string; count: number; mine: boolean }[];
  attachments: { id: string; filename: string; length: string; videoPath?: string; thumbnailPath?: string }[];
  mentionsMe: boolean;
}

/** Exact server fields; text parsing and username substring guesses are unnecessary. */
export function messageDetails(message: Message, currentUser: string, name: (id: string) => string,
  visible: readonly Message[]): MessageDetails {
  const reactions = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const reaction of message.reactions ?? []) {
    const group = reactions.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
    group.count++;
    group.mine ||= reaction.user_id === currentUser;
    reactions.set(reaction.emoji, group);
  }
  const parent = visible.find(candidate => candidate.id === message.reply_to && candidate.channel_id === message.channel_id);
  return {
    authorId: message.author_id, authorName: name(message.author_id), createdAt: message.created_at,
    editedAt: message.edited_at ?? undefined, pinned: message.pinned ?? false,
    replyTo: parent ? { id: parent.id, authorName: name(parent.author_id), excerpt: parent.body.slice(0, 160) } : null,
    reactions: [...reactions.values()], mentionsMe: message.mention_ids?.includes(currentUser) ?? false,
    attachments: (message.attachments ?? []).map(attachment => ({ id: attachment.id, filename: attachment.filename,
      length: attachment.length, videoPath: attachment.video_path ?? undefined, thumbnailPath: attachment.thumbnail_path ?? undefined })),
  };
}
