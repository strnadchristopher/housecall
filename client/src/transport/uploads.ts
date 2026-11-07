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
    try {
      upload = await this.api.request<Upload>(
        `/api/uploads/${uploadId}/complete`,
        { method: "POST", body: "{}", signal: controller.signal },
      );
    } catch (error) {
      if (!controller.signal.aborted && this.active === controller)
        this.publish(await this.api.get<Upload>(`/api/uploads/${uploadId}`, controller.signal), controller);
      throw error;
    }
    this.publish(upload, controller);
    return upload;
  }
}
