import { decodeInviteCode } from "./inviteCode";
import { parseInviteLink } from "../transport/deepLinks";

/** Accepts "chat.example.com", a full origin, an invite link or an invite code. */
export function parseServerInput(input: string): { origin: string; token: string } {
  const text = input.trim();
  if (!text) throw new Error("Server address required");
  const code = decodeInviteCode(text);
  if (code) return { origin: code.origin, token: code.token };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Server address not recognized");
  }
  if (url.hash.startsWith("#invite=")) {
    const invite = parseInviteLink(`${url.origin}/${url.hash}`, url.origin);
    if (!invite) throw new Error("Invite link not recognized");
    return { origin: invite.server_origin, token: invite.token };
  }
  return { origin: url.origin, token: "" };
}
