import { describe, expect, it, vi } from "vitest";
import { resetVm } from "../src/transport/vm";
import type { Api } from "../src/transport/api";
import type { ActivitySnapshot } from "../src/data/activities";
const snapshot = { kind: "vm", host: "host", revision: 4, controller: { user_id: "host", expires_at_ms: Date.now() + 30_000 } } as ActivitySnapshot;
describe("VM reset intent transport", () => {
  it("requires both host and controller before sending destructive intent", async () => {
    const post = vi.fn();
    await expect(resetVm({ post } as unknown as Api, "room", snapshot, "viewer", "id")).rejects.toThrow("host");
    await expect(resetVm({ post } as unknown as Api, "room", { ...snapshot, controller: null }, "host", "id")).rejects.toThrow("control");
    expect(post).not.toHaveBeenCalled();
  });
  it("retains the same operation across uncertain retries and supplies revision/confirmation", async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce({ operation: "id", outcome: "reset" });
    const api = { post } as unknown as Api;
    await expect(resetVm(api, "room/a", snapshot, "host", "id")).rejects.toThrow("network lost");
    await expect(resetVm(api, "room/a", snapshot, "host", "id")).resolves.toMatchObject({ outcome: "reset" });
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    expect(post.mock.calls[1]).toEqual(["/api/channels/room%2Fa/vm/reset", { expected_revision: 4, operation: "id", confirmation: "discard_vm_changes" }]);
  });
});
