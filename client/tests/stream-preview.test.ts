import { describe, expect, it } from "vitest";
import { fitJpeg, PREVIEW_MAX_BYTES, previewEnabled, setPreviewEnabled } from "../src/state/streamPreview";

describe("stream preview upload", () => {
  it("steps quality and size down until the picture fits the server limit", async () => {
    const sizes: Record<string, number> = { "0.7@640": 90000, "0.5@640": 70000, "0.35@640": 66000, "0.35@480": 40000 };
    const tried: string[] = [];
    const blob = await fitJpeg(async (quality, width) => {
      const key = `${quality}@${width}`;
      tried.push(key);
      return new Blob([new Uint8Array(sizes[key] ?? 1000)], { type: "image/jpeg" });
    });
    expect(blob!.size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(tried).toEqual(["0.7@640", "0.5@640", "0.35@640", "0.35@480"]);
  });
  it("gives up with nothing when no setting fits", async () => {
    expect(await fitJpeg(async () => new Blob([new Uint8Array(PREVIEW_MAX_BYTES + 1)]))).toBeUndefined();
  });
  it("is on unless the person turned it off, and remembers the choice", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
    expect(previewEnabled(storage)).toBe(true);
    setPreviewEnabled(false, storage);
    expect(previewEnabled(storage)).toBe(false);
    setPreviewEnabled(true, storage);
    expect(previewEnabled(storage)).toBe(true);
  });
});
