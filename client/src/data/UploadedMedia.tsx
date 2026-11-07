import { useEffect, useRef } from "react";
import type { Api } from "../transport/api";
import { UploadedVideo } from "../transport/video";

/** Semantic media binding; Opus owns its presentation. */
export function UploadedMedia({ api, path, onError }: { api: Api; path: string; onError: (message: string) => void }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const player = new UploadedVideo(element.current, api, onError);
    void player.load(path);
    return () => player.destroy();
  }, [api, path, onError]);
  return <video ref={element} controls playsInline data-testid="uploaded-media" aria-label="Uploaded video" />;
}
