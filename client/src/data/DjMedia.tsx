import { useEffect, useRef } from "react";
import { DjPlayer } from "../transport/dj";
import type { Api } from "../transport/api";
import type { ActivitySnapshot } from "./activities";

/** Functional native audio element; all visual design remains with Opus. */
export function DjMedia({ api, path, channel, snapshot, onError }: {
  api: Api; path: string; channel: string; snapshot: ActivitySnapshot; onError: (message: string) => void;
}) {
  const element = useRef<HTMLAudioElement>(null);
  const player = useRef<DjPlayer | undefined>(undefined);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => {
    if (!element.current) return;
    const instance = new DjPlayer(element.current, api, onError);
    player.current = instance;
    void instance.load(path, channel);
    instance.update(latest.current);
    return () => { instance.destroy(); player.current = undefined; };
  }, [api, path, channel, onError]);
  useEffect(() => player.current?.update(snapshot), [snapshot]);
  return <audio ref={element} controls data-testid="dj-media" aria-label="Shared DJ playback" />;
}
