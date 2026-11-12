/** Per-device accent colour. Values live in accents.css; this only picks one. */
export const ACCENTS = [
  { id: "lavender", label: "Lavender" },
  { id: "sky", label: "Sky" },
  { id: "mint", label: "Mint" },
  { id: "rose", label: "Rose" },
  { id: "coral", label: "Coral" },
  { id: "amber", label: "Amber" },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const KEY = "hc-accent";

function browserStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function isAccent(value: unknown): value is AccentId {
  return ACCENTS.some(accent => accent.id === value);
}
export function readAccent(storage: StorageLike | undefined = browserStorage()): AccentId {
  let value: string | null = null;
  try { value = storage?.getItem(KEY) ?? null; } catch { /* storage unavailable: default */ }
  return isAccent(value) ? value : "lavender";
}
export function applyAccent(
  id: AccentId = readAccent(),
  root: { dataset: Record<string, string | undefined> } = document.documentElement,
  storage: StorageLike | undefined = browserStorage(),
): AccentId {
  root.dataset.accent = id;
  try { storage?.setItem(KEY, id); } catch { /* not remembered; still applied */ }
  return id;
}
