import { useEffect, useRef } from "react";
import { useChords } from "../../../core/context";
import { copy } from "../../copy";
import { Button } from "../../kit";

function Screen({ stream }: { stream: MediaStream }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
    return () => { node.srcObject = null; };
  }, [stream]);
  return <video ref={element} className="hc-film" autoPlay playsInline aria-label={copy.chords.screen} />;
}

/** Shared browser: its stream while a session is live, and what the current backend lets a member do. */
export function SharedBrowserPanel() {
  const chords = useChords();
  const browser = chords.browser;
  if (!browser) return <div className="hc-stack"><p className="hc-pair"><span>{copy.chords.browserPhase}</span><strong>{copy.state.offline}</strong></p></div>;
  return (
    <div className="hc-stack" data-testid="screen-browser">
      {browser.streams.map(stream => <Screen key={stream.id} stream={stream} />)}
      <p className="hc-pair"><span>{copy.chords.browserPhase}</span><strong>{browser.phase}</strong></p>
      {browser.resetOutcome && <p className="hc-pair"><span>{copy.chords.resetOutcome}</span><strong>{browser.resetOutcome}</strong></p>}
      {browser.canStop && <Button kind="danger" onClick={() => void chords.stopBrowser()}>{copy.chords.stopBrowser}</Button>}
      <Button onClick={() => void chords.checkBrowserReset()}>{copy.chords.checkReset}</Button>
    </div>
  );
}
