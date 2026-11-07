import type { User } from "./types";
export function mentionedUsers(body: string, members: User[]): string[] {
  const names = new Set(
    [
      ...body.matchAll(/(?:^|\s)@([A-Za-z0-9_-]{2,32})(?=$|[^A-Za-z0-9_-])/g),
    ].map((m) => m[1].toLowerCase()),
  );
  return members
    .filter((m) => names.has(m.username.toLowerCase()))
    .map((m) => m.id);
}
export function mentionCandidates(body: string, members: User[]): User[] {
  const match = body.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match
    ? members
        .filter((m) =>
          m.username.toLowerCase().startsWith(match[1].toLowerCase()),
        )
        .slice(0, 10)
    : [];
}
export function completeMention(body: string, username: string) {
  return body.replace(/@([A-Za-z0-9_-]*)$/, `@${username} `);
}
