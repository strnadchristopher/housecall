import { useEffect, useState, type FormEvent } from "react";
import { useCall } from "../../core/context";
import { copy } from "../copy";
import { Button, ErrorLine, Field } from "../kit";
import { previewEnabled, setPreviewEnabled } from "../../state/streamPreview";
import { loadSoundSettings, saveSoundSettings, play } from "../../state/sounds";
import { setSpeaker, sinkSupported, speakerChoice } from "../../state/audioOutput";
import { SHORTCUTS, keyLabel } from "./useCallShortcuts";

/** Microphone and camera choice, bitrate and noise suppression. Lives in Settings. */
export function DeviceMenu() {
  const call = useCall();
  const [bitrate, setBitrate] = useState(String(call.bitrate));
  const [noise, setNoise] = useState(call.noiseSuppression);
  const [preview, setPreview] = useState(previewEnabled());
  const [sounds, setSounds] = useState(loadSoundSettings());
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [speaker, setSpeakerState] = useState(speakerChoice());
  const canSink = sinkSupported();
  useEffect(() => {
    const refresh = () => {
      void call.refreshDevices();
      void navigator.mediaDevices?.enumerateDevices().then(all => setSpeakers(all.filter(device => device.kind === "audiooutput"))).catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const changeSounds = (next: typeof sounds) => { setSounds(next); saveSoundSettings(next); };
  const pick = (kind: "microphone" | "camera") => (
    <label className="hc-field">
      <span className="hc-field__label">{kind === "microphone" ? copy.call.microphone : copy.call.camera}</span>
      <select value={call.selected[kind] ?? ""} onChange={event => call.selectDevices({ ...call.selected, [kind]: event.target.value || undefined })}>
        <option value="">{copy.call.defaultDevice}</option>
        {call.devices.filter(device => device.kind === kind && device.id).map((device, index) => (
          <option key={device.id} value={device.id}>{device.label || `${kind === "microphone" ? copy.call.microphone : copy.call.camera} ${index + 1}`}</option>
        ))}
      </select>
    </label>
  );
  const apply = (event: FormEvent) => { event.preventDefault(); void call.setAudio(Number(bitrate), noise); };
  return (
    <div className="hc-stack">
      {pick("microphone")}
      {pick("camera")}
      {canSink ? (
        <label className="hc-field">
          <span className="hc-field__label">{copy.call.speaker}</span>
          <select value={speaker} onChange={event => { setSpeakerState(event.target.value); setSpeaker(event.target.value); }}>
            <option value="">{copy.call.speakerDefault}</option>
            {speakers.filter(device => device.deviceId && device.deviceId !== "default").map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || `${copy.call.speaker} ${index + 1}`}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="hc-pair" data-testid="speaker-fixed"><span>{copy.call.speaker}</span><strong>{copy.call.speakerDefault}</strong></div>
      )}
      <Button onClick={() => void call.refreshDevices()}>{copy.call.refresh}</Button>
      <label className="hc-check"><input type="checkbox" checked={sounds.on} onChange={event => changeSounds({ ...sounds, on: event.target.checked })} /><span>{copy.call.sounds}</span></label>
      <p className="hc-note">{copy.call.soundsHint}</p>
      <label className="hc-field">
        <span className="hc-field__label">{copy.call.soundVolume}</span>
        <input type="range" min={0} max={100} value={Math.round(sounds.volume * 100)} disabled={!sounds.on}
          onChange={event => changeSounds({ ...sounds, volume: Number(event.target.value) / 100 })}
          onPointerUp={() => play("join", sounds)} onKeyUp={() => play("join", sounds)} />
      </label>
      <section className="hc-stack" aria-label={copy.call.shortcuts} data-testid="shortcuts">
        <h3>{copy.call.shortcuts}</h3>
        {SHORTCUTS.map(shortcut => (
          <div key={shortcut.id} className="hc-pair">
            <span>{shortcut.id === "mute" ? copy.call.shortcutMute : copy.call.shortcutDeafen}</span>
            <strong>{shortcut.keys.map(keyLabel).join(" + ")}</strong>
          </div>
        ))}
        <p className="hc-note">{copy.call.shortcutsHint}</p>
      </section>
      <label className="hc-check"><input type="checkbox" checked={preview} onChange={event => { setPreview(event.target.checked); setPreviewEnabled(event.target.checked); }} /><span>{copy.call.previewMine}</span></label>
      <p className="hc-note">{copy.call.previewMineHint}</p>
      {call.phase === "live" && (
        <form className="hc-stack" onSubmit={apply}>
          <Field label={copy.call.bitrate} type="number" min={6000} max={510000} value={bitrate} onChange={event => setBitrate(event.target.value)} />
          <label className="hc-check"><input type="checkbox" checked={noise} onChange={event => setNoise(event.target.checked)} /><span>{copy.call.noise}</span></label>
          <Button kind="primary" type="submit">{copy.call.apply}</Button>
        </form>
      )}
      <ErrorLine text={call.error} />
    </div>
  );
}
