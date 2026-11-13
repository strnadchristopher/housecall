import { describe, expect, it } from "vitest";
import { BIO_MAX, normalizeBio } from "../src/data/bio";

describe("bio", () => {
  it("collapses whitespace and line breaks to single spaces and trims", () => {
    expect(normalizeBio("  Kettle's   on.\n\nKnock\tfirst.  ")).toBe("Kettle's on. Knock first.");
  });
  it("clears to null when empty", () => {
    expect(normalizeBio("   \n ")).toBeNull();
    expect(normalizeBio("")).toBeNull();
  });
  it("stops at 190 characters", () => {
    expect(BIO_MAX).toBe(190);
    expect(normalizeBio("x".repeat(300))!.length).toBe(190);
  });
  it("stays plain text: markup is kept as typed, never interpreted", () => {
    expect(normalizeBio("**hi** [a](http://x)")).toBe("**hi** [a](http://x)");
  });
});
