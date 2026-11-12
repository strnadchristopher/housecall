/**
 * Invite codes: hc1.<base64url(server origin)>.<64 lowercase hex token>.
 * Encoded, not hashed: pasting a code must give the app the server address.
 * The code is a bearer secret, like the invite link.
 */
export interface DecodedInvite { origin: string; token: string }
const PREFIX = "hc1.";

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}
/** Same origin rule as invite links: https, or http on loopback only; no credentials or path. */
export function isInviteOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && !url.username && !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
export function encodeInviteCode(origin: string, token: string): string {
  return `${PREFIX}${toBase64Url(origin)}.${token}`;
}
export function decodeInviteCode(input: string): DecodedInvite | undefined {
  const text = input.trim();
  if (!text.startsWith(PREFIX)) return;
  const parts = text.slice(PREFIX.length).split(".");
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return;
  let origin: string;
  try { origin = fromBase64Url(parts[0]); } catch { return; }
  return isInviteOrigin(origin) ? { origin, token: parts[1] } : undefined;
}
