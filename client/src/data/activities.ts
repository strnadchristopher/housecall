export interface ActivitySnapshot {
  kind: "plex" | "dj" | "vm";
  revision: number;
  server_time_ms: number;
  host: string;
  members: string[];
  playback: {
    media_id: string | null;
    playing: boolean;
    position_ms: number;
    anchored_at_ms: number;
    duration_ms: number | null;
  };
  queue: { id: string; title: string; requested_by: string; duration_ms: number; source: string }[];
  skip_votes: string[];
  controller: { user_id: string; expires_at_ms: number } | null;
  control_requests: string[];
}
export function acceptActivity(
  previous: ActivitySnapshot | undefined,
  next: ActivitySnapshot,
) {
  return previous && previous.revision > next.revision ? previous : next;
}
