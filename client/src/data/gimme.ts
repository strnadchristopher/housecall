import type { Api } from "../transport/api";
export type GimmeRequest = { media: "movie" | "tv"; query: string };
export interface GimmeRequestStatus {
  id: string;
  channel_id: string;
  user_id: string;
  request: GimmeRequest;
  state: "queued" | "pending" | "complete" | "failed";
  dry_run: boolean;
  provider_verified: boolean;
  result_status: string | null;
  result: { status: string; title?: string; tmdb_id?: number; release_state?: string; search_uncertain?: boolean; confirmation_required?: boolean } | null;
  confirmation_required: boolean;
  error_code: string | null;
  retryable: boolean;
  provider_outcome_unknown: boolean;
  provider_job_id: string | null;
  polling_paused: boolean;
  created_at: number;
  updated_at: number;
}
export interface GimmeSubmission {
  dry_run: boolean;
  provider_verified: boolean;
  operation: { state: "dry_run" | "queued"; method?: string; path?: string; body?: unknown; idempotency_key?: string };
  request: GimmeRequestStatus;
}
export function listGimmeRequests(api: Api, channelId: string) {
  return api.get<{ requests: GimmeRequestStatus[] }>(`/api/channels/${encodeURIComponent(channelId)}/gimme/requests`);
}
/** Preserve this key when retrying the same UI submission; a new key is a new intended operation. */
export function submitGimmeRequest(api: Api, channelId: string, request: GimmeRequest, idempotencyKey: string) {
  return api.post<GimmeSubmission>(`/api/channels/${encodeURIComponent(channelId)}/gimme/requests`, { request, idempotency_key: idempotencyKey });
}
export function mergeGimmeUpdate(previous: GimmeRequestStatus[], next: GimmeRequestStatus): GimmeRequestStatus[] {
  const old = previous.find(item => item.id === next.id);
  if (old && (old.updated_at > next.updated_at || ((old.state === "complete" || old.state === "failed") && (next.state === "queued" || next.state === "pending")))) return previous;
  return [...previous.filter(item => item.id !== next.id), next].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(0, 100);
}
export function gimmeStatusText(item: GimmeRequestStatus): string {
  if (item.dry_run) return "Preview saved — no provider request sent";
  if (item.polling_paused) return "Provider polling paused while dry-run mode is enabled";
  if (item.confirmation_required) return "Confirmation required — no download was started by Housecall";
  if (item.provider_outcome_unknown) return "Provider outcome unknown — request ID retained; do not submit again";
  if (item.state === "queued") return "Request queued";
  if (item.state === "pending") return "Gimme is still processing this request";
  if (item.state === "failed") return `Request tracking failed: ${item.error_code ?? "unknown error"}`;
  if (item.result?.search_uncertain) return "Search remains uncertain: a backend is pending or failed";
  switch (item.result?.status) {
    case "already_owned": return "Already available in Plex";
    case "already_requested": return "Already requested";
    case "subscribed": case "already_subscribed": return "Subscribed — episode discovery scheduled; downloads not yet verified";
    case "release_unavailable": return `Release unavailable${item.result.release_state ? `: ${item.result.release_state}` : ""}`;
    case "no_torrent_found": return "Gimme completed the search without a usable result";
    default: return `Gimme completed: ${item.result?.status ?? item.result_status ?? "unknown result"}`;
  }
}
