/**
 * Screen share quality. Three presets, chosen before or during a share. Each sets what the capture is
 * asked for, the track's `contentHint` (what the encoder optimises for), the sender's
 * `degradationPreference` (what gives first when the network cannot keep up) and a bitrate ceiling.
 * The choice is a device-local preference, not a secret.
 */
export type ShareQuality = "smooth" | "sharp" | "source";
export const SHARE_QUALITIES: readonly ShareQuality[] = ["smooth", "sharp", "source"];

export interface SharePreset {
  contentHint: "motion" | "detail";
  degradationPreference: "maintain-framerate" | "maintain-resolution";
  /** Bits per second, per encoding. */
  maxBitrate: number;
  frameRate: number;
  width: number;
  height: number;
}

export const SHARE_PRESETS: Record<ShareQuality, SharePreset> = {
  // Games and video: keep the motion, let the picture soften.
  smooth: { contentHint: "motion", degradationPreference: "maintain-framerate", maxBitrate: 2_500_000, frameRate: 60, width: 1920, height: 1080 },
  // Documents and code: keep the text crisp, let the frame rate drop.
  sharp: { contentHint: "detail", degradationPreference: "maintain-resolution", maxBitrate: 5_000_000, frameRate: 30, width: 2560, height: 1440 },
  // The whole screen as it is, up to 4K, with the highest ceiling.
  source: { contentHint: "detail", degradationPreference: "maintain-resolution", maxBitrate: 8_000_000, frameRate: 30, width: 3840, height: 2160 },
};

const KEY = "hc.shareQuality";
const store = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

export function readShareQuality(storage: Storage | undefined = store()): ShareQuality {
  const value = storage?.getItem(KEY);
  return SHARE_QUALITIES.includes(value as ShareQuality) ? (value as ShareQuality) : "smooth";
}
export function writeShareQuality(quality: ShareQuality, storage: Storage | undefined = store()) {
  storage?.setItem(KEY, quality);
}

/** Constraints for `getDisplayMedia`'s video: ideal values, so a smaller screen is never stretched. */
export function captureConstraints(quality: ShareQuality): MediaTrackConstraints {
  const preset = SHARE_PRESETS[quality];
  return { frameRate: { ideal: preset.frameRate }, width: { ideal: preset.width }, height: { ideal: preset.height } };
}

/** Sets the hint on the track and the rule and ceiling on the sender. Safe to call again during a share. */
export async function applyShareQuality(sender: RTCRtpSender, track: MediaStreamTrack, quality: ShareQuality) {
  const preset = SHARE_PRESETS[quality];
  track.contentHint = preset.contentHint;
  const parameters = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  for (const encoding of parameters.encodings) { encoding.maxBitrate = preset.maxBitrate; encoding.scaleResolutionDownBy = 1; }
  parameters.degradationPreference = preset.degradationPreference;
  await sender.setParameters(parameters);
}

/** Puts the video sender back to its defaults once a share ends and the camera (or nothing) returns. */
export async function clearShareQuality(sender: RTCRtpSender) {
  const parameters = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
  for (const encoding of parameters.encodings ?? []) { delete encoding.maxBitrate; delete encoding.scaleResolutionDownBy; }
  parameters.degradationPreference = "balanced";
  await sender.setParameters(parameters);
}

/**
 * The SFU gives a publisher's voice and picture the stream id of the publisher, and the sound of a
 * shared screen the same id with `-share`. That is how a viewer keeps the two apart.
 */
export function shareStreamId(id: string): { peer: string; share: boolean } {
  return id.endsWith("-share") ? { peer: id.slice(0, -"-share".length), share: true } : { peer: id, share: false };
}
