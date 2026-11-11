import { useEffect, useState, type FormEvent } from "react";
import { useCall } from "../../core/context";
import { copy } from "../copy";
import { Button, ErrorLine, Field } from "../kit";

/** Microphone and camera choice, bitrate and noise suppression. Lives in Settings. */
export function DeviceMenu() {
  const call = useCall();
  const [bitrate, setBitrate] = useState(String(call.bitrate));
  const [noise, setNoise] = useState(call.noiseSuppression);
  useEffect(() => { void call.refreshDevices(); }, []);
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
      <Button onClick={() => void call.refreshDevices()}>{copy.call.refresh}</Button>
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
