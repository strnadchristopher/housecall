import { describe, expect, it } from "vitest";
import { initialConversation } from "../src/state/initialConversation";

const channels = [
  { id: "dm1", kind: "dm" as const, server_id: null },
  { id: "random", kind: "channel" as const, server_id: "home" },
  { id: "general", kind: "channel" as const, server_id: "home" },
];
const servers = [{ id: "home", general_channel_id: "general" }];

describe("initial conversation", () => {
  it("reopens the remembered chat when it still exists", () => {
    expect(initialConversation(channels, servers, "random")).toBe("random");
  });
  it("falls back to the server's general chat", () => {
    expect(initialConversation(channels, servers, "deleted")).toBe("general");
    expect(initialConversation(channels, servers)).toBe("general");
  });
  it("then any channel, then anything", () => {
    expect(initialConversation(channels, [])).toBe("random");
    expect(initialConversation([channels[0]], [])).toBe("dm1");
    expect(initialConversation([], [])).toBeUndefined();
  });
});
