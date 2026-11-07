import type { Api } from "./api";
import { ResumableUpload } from "./uploads";

export interface ReportInput {
  kind: "bug" | "feature";
  body: string;
  logs: string;
  logsConsent: boolean;
  screenshot?: File;
  screenshotConsent: boolean;
}

/** Consent is checked before any screenshot bytes leave the device. */
export async function submitReport(api: Api, channel: string, input: ReportInput) {
  if (input.screenshot && !input.screenshotConsent)
    throw new Error("Consent to sending the selected screenshot, or remove it.");
  let uploadId: string | undefined;
  try {
    if (input.screenshot) {
      const uploader = new ResumableUpload(api, () => {});
      const upload = await uploader.create(channel, input.screenshot);
      uploadId = upload.id;
      const complete = await uploader.resume(upload.id, input.screenshot);
      if (complete.status !== "ready")
        throw new Error("The screenshot must pass scanning before it can be attached.");
    }
    return await api.post<{ id: string }>("/api/reports", {
      kind: input.kind,
      body: input.body,
      logs: input.logsConsent ? input.logs : null,
      logs_consent: input.logsConsent,
      screenshot_id: uploadId ?? null,
      screenshot_consent: !!uploadId && input.screenshotConsent,
    });
  } catch (error) {
    // A rejected report must not leave an unattached upload behind when authorized.
    if (uploadId) await api.delete(`/api/uploads/${uploadId}`).catch(() => {});
    throw error;
  }
}

/** Bounded owner-only browser download. The general upload path has no total-size cap. */
export async function reportScreenshot(api: Api, reportId: string, signal: AbortSignal) {
  const response = await fetch(api.mediaRequest(`/api/reports/${encodeURIComponent(reportId)}/screenshot`, { signal }));
  if (!response.ok) throw new Error(`Screenshot unavailable (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Screenshot response is empty");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16 * 1024 * 1024)
        throw new Error("Screenshot exceeds the 16 MiB screenshot-download limit.");
      parts.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  const blob = new Blob(parts);
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  const mime = header[0] === 137 && ascii(1, 4) === "PNG" ? "image/png"
    : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg"
    : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mime) throw new Error("Screenshot downloads support PNG, JPEG or WebP.");
  return new Blob(parts, { type: mime });
}
