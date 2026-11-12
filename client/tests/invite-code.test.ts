import { describe, expect, it } from "vitest";
import { decodeInviteCode, encodeInviteCode } from "../src/data/inviteCode";
import { parseServerInput } from "../src/data/serverInput";
import { parseSchemeInvite } from "../src/transport/deepLinks";

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

describe("housecall:// invite links", () => {
  const code = encodeInviteCode("https://chat.example.test", token);
  it("accepts exactly housecall://invite?code=<code>", () => {
    expect(parseSchemeInvite(`housecall://invite?code=${code}`)).toEqual({ token, server_origin: "https://chat.example.test" });
  });
  it("rejects extra parameters, fragments and paths", () => {
    for (const bad of [`housecall://invite?code=${code}&next=x`, `housecall://invite?next=x&code=${code}`, `housecall://invite?code=${code}#x`,
      `housecall://invite/?code=${code}`, `housecall://invite/x?code=${code}`, `housecall://invite?code=${code} `])
      expect(parseSchemeInvite(bad), bad).toBeUndefined();
  });
  it("rejects the wrong host or scheme", () => {
    for (const bad of [`housecall://join?code=${code}`, `housecall://evil.test/invite?code=${code}`, `https://invite?code=${code}`,
      `HOUSECALL://invite?code=${code}`, `housecalls://invite?code=${code}`])
      expect(parseSchemeInvite(bad), bad).toBeUndefined();
  });
  it("rejects a code that is not a valid invite code", () => {
    expect(parseSchemeInvite("housecall://invite?code=hc1.nope.abc")).toBeUndefined();
    expect(parseSchemeInvite(`housecall://invite?code=${encodeInviteCode("http://chat.example.test", token)}`)).toBeUndefined();
    expect(parseSchemeInvite(`housecall://invite?code=${"a".repeat(3000)}`)).toBeUndefined();
  });
});
