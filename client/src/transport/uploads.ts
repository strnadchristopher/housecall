import { ApiError, type Api } from "./api";
export interface UploadScan {
  attempt_id: string;
  engine: "unspecified" | "disabled" | "clamav" | "withsecure";
  verdict: "pending" | "no_finding" | "detected" | "rejected" | "unavailable" | "timed_out" | "incomplete";
  reason: "awaiting_scanner" | "scanner_not_configured" | "scanner_unavailable" | "scanner_timed_out" | "engine_limit" | "encrypted_or_unsupported" | "blocking_finding" | "unclassified_rejection" | "source_not_consumed" | "source_read_failed" | "engine_reported_no_finding";
  coverage: "unknown" | "stream_consumed" | "incomplete" | "engine_limited";
  bytes_consumed: string;
  finished_at_ms: number | null;
}
export function uploadScanMessage(scan?: UploadScan | null): string {
  if (!scan) return "File remains quarantined. No scan result is recorded.";
  switch (scan.reason) {
    case "awaiting_scanner": return "Scan result is pending. File remains quarantined.";
    case "scanner_not_configured": return "A scanner is not configured. File remains quarantined.";
    case "scanner_unavailable": return "Scanner unavailable. File remains quarantined.";
    case "scanner_timed_out": return "Scanning timed out. File remains quarantined.";
    case "engine_limit": return "The scanner reached an analysis limit. File remains quarantined.";
    case "encrypted_or_unsupported": return "The scanner could not fully analyze this content. File remains quarantined.";
    case "blocking_finding": return "The scanner reported a blocking finding. File remains quarantined.";
    case "source_not_consumed": return "The scanner did not receive the complete file. File remains quarantined.";
    case "source_read_failed": return "The encrypted source could not be read completely. File remains quarantined.";
    case "engine_reported_no_finding": return "The scanner reported no finding after reading the stream. Embedded-content coverage is not guaranteed.";
    default: return "The scanner rejected the file without a classified verdict. File remains quarantined.";
  }
}
export interface Upload {
  id: string;
  channel_id: string;
  filename: string;
  length: string;
  offset: string;
  status: "uploading" | "quarantined" | "ready";
  scan?: UploadScan | null;
}
/** File slices bound memory regardless of total file size; server offsets are authoritative. */
export class ResumableUpload {
  private active?: AbortController;
  constructor(
    private api: Api,
    private changed: (upload: Upload) => void,
  ) {}
  pause() {
    this.active?.abort();
    this.active = undefined;
  }
  private begin() {
    this.pause();
    const controller = new AbortController();
    this.active = controller;
    return controller;
  }
  private publish(upload: Upload, controller: AbortController) {
    if (controller.signal.aborted || this.active !== controller)
      throw new DOMException("Upload paused", "AbortError");
    this.changed(upload);
  }
  async create(channelId: string, file: File) {
    const controller = this.begin();
    const upload = await this.api.request<Upload>("/api/uploads", {
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ channel_id: channelId, filename: file.name, length: String(file.size) }),
    });
    this.publish(upload, controller);
    return upload;
  }
  async resume(uploadId: string, file: File) {
    const controller = this.begin();
    let upload = await this.api.get<Upload>(
      `/api/uploads/${uploadId}`,
      controller.signal,
    );
    if (
      upload.filename !== file.name ||
      BigInt(upload.length) !== BigInt(file.size)
    )
      throw new Error("Select the original file with the same name and size");
    if (upload.status !== "uploading") {
      this.publish(upload, controller);
      return upload;
    }
    this.publish(upload, controller);
    while (BigInt(upload.offset) < BigInt(upload.length)) {
      if (controller.signal.aborted)
        throw new DOMException("Upload paused", "AbortError");
      const offset = Number(upload.offset);
      const chunk = file.slice(
        offset,
        Math.min(offset + 4 * 1024 * 1024, file.size),
      );
      upload = await this.api.request<Upload>(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/octet-stream",
          "Upload-Offset": upload.offset,
        },
        body: chunk,
        signal: controller.signal,
      });
      this.publish(upload, controller);
    }
    return this.complete(uploadId, controller);
  }
  async refreshScan(uploadId: string) {
    const controller = this.begin();
    const upload = await this.api.get<Upload>(`/api/uploads/${uploadId}`, controller.signal);
    this.publish(upload, controller);
    return upload;
  }
  async retryScan(uploadId: string) { return this.complete(uploadId, this.begin()); }
  private async complete(uploadId: string, controller: AbortController) {
    let upload: Upload;
    try {
      upload = await this.api.request<Upload>(`/api/uploads/${uploadId}/complete`,
        { method: "POST", body: "{}", signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && this.active === controller) {
        const current = await this.api.get<Upload>(`/api/uploads/${uploadId}`, controller.signal);
        this.publish(current, controller);
        if (error instanceof ApiError && error.status === 423 && current.status === "quarantined")
          throw new ApiError(423, uploadScanMessage(current.scan));
      }
      throw error;
    }
    this.publish(upload, controller);
    return upload;
  }
}
