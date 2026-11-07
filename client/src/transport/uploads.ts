import type { Api } from "./api";
export interface Upload {
  id: string;
  channel_id: string;
  filename: string;
  length: string;
  offset: string;
  status: "uploading" | "quarantined" | "ready";
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
  }
  async create(channelId: string, file: File) {
    const upload = await this.api.post<Upload>("/api/uploads", {
      channel_id: channelId,
      filename: file.name,
      length: String(file.size),
    });
    this.changed(upload);
    return upload;
  }
  async resume(uploadId: string, file: File) {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
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
      this.changed(upload);
      return upload;
    }
    this.changed(upload);
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
      this.changed(upload);
    }
    try {
      upload = await this.api.post<Upload>(
        `/api/uploads/${uploadId}/complete`,
        {},
      );
    } catch (error) {
      this.changed(await this.api.get<Upload>(`/api/uploads/${uploadId}`));
      throw error;
    }
    this.changed(upload);
    return upload;
  }
}
