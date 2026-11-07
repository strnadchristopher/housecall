import { useEffect, useRef } from "react";
import type { PlexPlayer } from "../transport/plex";
import type { Api } from "../transport/api";
import type { ActivitySnapshot } from "./activities";
export function PlexMedia({
  api,
  manifest,
  snapshot,
  onError,
  subtitles,
}: {
  api: Api;
  manifest: string;
  snapshot: ActivitySnapshot;
  onError: (message: string) => void;
  subtitles: boolean;
}) {
  const element = useRef<HTMLVideoElement>(null),
    player = useRef<PlexPlayer | undefined>(undefined),
    latest = useRef({ snapshot, subtitles });
  latest.current = { snapshot, subtitles };
  useEffect(() => {
    let cancelled = false;
    let instance: PlexPlayer | undefined;
    void import("../transport/plex")
      .then(({ PlexPlayer }) => {
        if (cancelled || !element.current) return;
        instance = new PlexPlayer(element.current, api, onError);
        player.current = instance;
        instance.load(manifest);
        instance.update(latest.current.snapshot);
        instance.subtitles(latest.current.subtitles);
      })
      .catch((error) => {
        if (!cancelled)
          onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      instance?.destroy();
      player.current = undefined;
    };
  }, [api, manifest, onError]);
  useEffect(() => player.current?.update(snapshot), [snapshot]);
  useEffect(() => player.current?.subtitles(subtitles), [subtitles]);
  return (
    <video
      ref={element}
      playsInline
      data-testid="plex-media"
      aria-label="Shared Plex playback"
    />
  );
}
