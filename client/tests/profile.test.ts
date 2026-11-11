import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarPath, iconPath, nameOf, userName } from "../src/data/people";
import { MAX_GIF_BYTES, fitWithin, prepareImage } from "../src/ui/settings/resizeImage";

function gifFile(length: number, type = "image/gif"): File {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("GIF89a"));
  return new File([bytes], "wave.gif", { type });
}

describe("prepareImage", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("passes a GIF through byte-identical so it keeps animating", async () => {
    const file = gifFile(1_500_000);
    const out = await prepareImage(file);
    expect(out).toBe(file);
    expect(Buffer.compare(Buffer.from(await out.arrayBuffer()), Buffer.from(await file.arrayBuffer()))).toBe(0);
  });

  it("recognises a GIF by its bytes, not its declared type", async () => {
    const file = gifFile(100, "application/octet-stream");
    expect(await prepareImage(file)).toBe(file);
  });

  it("accepts a GIF of exactly 2 MB and rejects one byte more", async () => {
    await expect(prepareImage(gifFile(MAX_GIF_BYTES))).resolves.toBeDefined();
    await expect(prepareImage(gifFile(MAX_GIF_BYTES + 1))).rejects.toThrow("This image is too large");
  });

  it("still resizes a PNG to a WebP", async () => {
    const webp = new Blob(["webp"], { type: "image/webp" });
    const close = vi.fn();
    const draw = vi.fn();
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1024, height: 512, close }));
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: draw }),
        toBlob: (done: (blob: Blob | null) => void) => done(webp),
      }),
    });
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], "pic.png", { type: "image/png" });
    expect(await prepareImage(png)).toBe(webp);
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 256, 128);
    expect(close).toHaveBeenCalled();
  });
});

describe("fitWithin", () => {
  it("scales a 1024x768 image to 256x192", () => {
    expect(fitWithin(1024, 768, 256)).toEqual({ width: 256, height: 192 });
  });
  it("scales a portrait image by its height", () => {
    expect(fitWithin(600, 1200, 256)).toEqual({ width: 128, height: 256 });
  });
  it("never scales up", () => {
    expect(fitWithin(100, 50, 256)).toEqual({ width: 100, height: 50 });
  });
  it("keeps at least one pixel on a thin image", () => {
    expect(fitWithin(5000, 2, 256)).toEqual({ width: 256, height: 1 });
  });
});

describe("display names", () => {
  it("prefers the display name and falls back to the username", () => {
    expect(nameOf({ displayName: "Ada L.", username: "ada" })).toBe("Ada L.");
    expect(nameOf({ displayName: undefined, username: "ada" })).toBe("ada");
    expect(userName({ display_name: null, username: "ada" })).toBe("ada");
    expect(userName({ display_name: "", username: "ada" })).toBe("ada");
  });
  it("builds cache-busted media paths only when an image exists", () => {
    expect(avatarPath({ id: "u1", avatar_rev: 0 })).toBeUndefined();
    expect(avatarPath({ id: "u1" })).toBeUndefined();
    expect(avatarPath({ id: "u1", avatar_rev: 3 })).toBe("/api/users/u1/avatar?v=3");
    expect(iconPath({ id: "home", icon_rev: 0 })).toBeUndefined();
    expect(iconPath({ id: "home", icon_rev: 2 })).toBe("/api/servers/home/icon?v=2");
  });
});
