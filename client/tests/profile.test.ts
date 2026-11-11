import { describe, expect, it } from "vitest";
import { avatarPath, iconPath, nameOf, userName } from "../src/data/people";
import { fitWithin } from "../src/ui/settings/resizeImage";

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
