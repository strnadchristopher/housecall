/** The picture of your shared screen that others can peek at (docs/API.md, "voice/preview"). */
export const PREVIEW_MAX_BYTES = 65536;
export const PREVIEW_EVERY_MS = 15000;
const KEY = "hc.previewMine";

function store(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** On unless the person turned it off. Not a secret, so localStorage is fine. */
export function previewEnabled(storage: Storage | undefined = store()): boolean {
  return storage?.getItem(KEY) !== "off";
}
export function setPreviewEnabled(on: boolean, storage: Storage | undefined = store()) {
  storage?.setItem(KEY, on ? "on" : "off");
}

const STEPS: [quality: number, width: number][] = [[0.7, 640], [0.5, 640], [0.35, 640], [0.35, 480], [0.3, 400], [0.25, 320]];

/** Tries smaller and softer encodings until one is within the server's limit. */
export async function fitJpeg(encode: (quality: number, width: number) => Promise<Blob | null>): Promise<Blob | undefined> {
  for (const [quality, width] of STEPS) {
    const blob = await encode(quality, width);
    if (blob && blob.size <= PREVIEW_MAX_BYTES) return blob;
  }
  return undefined;
}

/** One frame of `stream` as a JPEG within the limit, or nothing when it cannot be drawn yet. */
export async function captureFrame(stream: MediaStream): Promise<Blob | undefined> {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) return undefined;
    return await fitJpeg((quality, width) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round(width * video.videoHeight / video.videoWidth);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    });
  } catch { return undefined; } finally { video.srcObject = null; }
}
