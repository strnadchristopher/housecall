/** HC-040 7.2: up to 190 characters of plain text, whitespace collapsed, empty clears it. */
export const BIO_MAX = 190;

export function normalizeBio(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim().slice(0, BIO_MAX).trim();
  return collapsed === "" ? null : collapsed;
}
