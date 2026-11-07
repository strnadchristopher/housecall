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
export function mentionedRoles(
  body: string,
  roles: { id: string; name: string }[],
): string[] {
  const matches: { id: string; start: number; end: number }[] = [];
  for (const role of [...roles].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = role.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of body.matchAll(
      new RegExp(`(?:^|\\s)@${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "giu"),
    )) {
      const start = match.index + match[0].indexOf("@"),
        end = match.index + match[0].length;
      if (
        !matches.some(
          (previous) => start < previous.end && end > previous.start,
        )
      )
        matches.push({ id: role.id, start, end });
    }
  }
  return [...new Set(matches.map((match) => match.id))];
}
export function roleCandidates(
  body: string,
  roles: { id: string; name: string }[],
) {
  const match = body.match(/(?:^|\s)@([^@]*)$/);
  return match
    ? roles
        .filter((role) =>
          role.name.toLowerCase().startsWith(match[1].toLowerCase()),
        )
        .slice(0, 10)
    : [];
}
export function completeRole(body: string, name: string) {
  return body.replace(/@[^@]*$/, `@${name} `);
}
