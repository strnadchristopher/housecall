import type { Server, User } from "./types";

/** What to show for a person: their display name, else the username they sign in with. */
export const nameOf = (person: { displayName?: string | null; username: string }) => person.displayName || person.username;

export const userName = (user: Pick<User, "username" | "display_name">) => nameOf({ displayName: user.display_name, username: user.username });

/** Authenticated image paths, cache-busted by revision so the long-lived cache stays correct. */
export const avatarPath = (user: Pick<User, "id" | "avatar_rev">) =>
  user.avatar_rev ? `/api/users/${encodeURIComponent(user.id)}/avatar?v=${user.avatar_rev}` : undefined;

export const iconPath = (server: Pick<Server, "id" | "icon_rev">) =>
  server.icon_rev ? `/api/servers/${encodeURIComponent(server.id)}/icon?v=${server.icon_rev}` : undefined;
