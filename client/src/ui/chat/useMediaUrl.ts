import { useEffect, useState } from "react";
import { useChat } from "../../core/context";

/** Fetches an authenticated media path into an object URL; revokes on unmount. */
export function useMediaUrl(path: string | undefined) {
  const chat = useChat();
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    setState({});
    if (!path) return;
    let url: string | undefined;
    let live = true;
    chat.fetchMedia(path)
      .then(blob => { if (!live) return; url = URL.createObjectURL(blob); setState({ url }); })
      .catch(error => { if (live) setState({ error: String(error) }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return state;
}
