import { describe, expect, it } from "vitest";
import { decodeInviteCode, encodeInviteCode } from "../src/data/inviteCode";
import { parseServerInput } from "../src/data/serverInput";

const token = "ab".repeat(32);
describe("invite codes", () => {
  it("matches the server's format", () => {
    expect(encodeInviteCode("http://localhost:1420", token)).toBe(`hc1.aHR0cDovL2xvY2FsaG9zdDoxNDIw.${token}`);
  });
  it("round-trips an https origin, tolerating whitespace", () => {
    const code = encodeInviteCode("https://chat.example.test", token);
    expect(code.startsWith("hc1.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA.")).toBe(true);
    expect(decodeInviteCode(`  ${code}\n`)).toEqual({ origin: "https://chat.example.test", token });
  });
  it("rejects anything that is not exactly a code", () => {
    const http = encodeInviteCode("http://chat.example.test", token);
    for (const bad of ["", "hc1.", `hc2.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA.${token}`, `hc1.!!!.${token}`,
      `hc1.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA.${token.toUpperCase()}`, `hc1.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA.${token}.x`,
      http, encodeInviteCode("https://u:p@chat.example.test", token), encodeInviteCode("https://chat.example.test/path", token)]) {
      expect(decodeInviteCode(bad), bad).toBeUndefined();
    }
  });
  it("server input accepts a code, a link, or a bare address", () => {
    expect(parseServerInput(encodeInviteCode("https://chat.example.test", token))).toEqual({ origin: "https://chat.example.test", token });
    expect(parseServerInput(`https://chat.example.test/#invite=${token}`)).toEqual({ origin: "https://chat.example.test", token });
    expect(parseServerInput("chat.example.test")).toEqual({ origin: "https://chat.example.test", token: "" });
    expect(() => parseServerInput("  ")).toThrow();
  });
});
