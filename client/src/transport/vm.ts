import type { ActivitySnapshot } from "../data/activities";
import type { Api } from "./api";

/** Coordinates are normalized to QEMU's inclusive 0..32767 absolute input range. */
export type VmInput = { type: "key"; key: string } |
  { type: "pointer"; x: number; y: number } | { type: "click"; button: string };

export async function sendVmInput(api: Api, channel: string, snapshot: ActivitySnapshot,
  user: string, event: VmInput): Promise<void> {
  if (snapshot.kind !== "vm" || snapshot.controller?.user_id !== user)
    throw new Error("Request VM control before sending input");
  // The server rechecks current voice/session/revision/lease after the private QMP handshake.
  await api.post(`/api/channels/${encodeURIComponent(channel)}/vm/input`, {
    expected_revision: snapshot.revision, event,
  });
}

/** Reuse operation after an uncertain network response: the supervisor persists its receipt. */
export async function resetVm(api: Api, channel: string, snapshot: ActivitySnapshot,
  user: string, operation: string): Promise<{ operation: string; outcome: "reset" | "rolled_back" }> {
  if (snapshot.kind !== "vm" || snapshot.host !== user || snapshot.controller?.user_id !== user)
    throw new Error("The VM host must hold control before resetting");
  return api.post(`/api/channels/${encodeURIComponent(channel)}/vm/reset`, {
    expected_revision: snapshot.revision, operation, confirmation: "discard_vm_changes",
  });
}
