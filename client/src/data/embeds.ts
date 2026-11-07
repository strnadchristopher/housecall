import type { Api } from "../transport/api";
export interface LinkPreview {
  url: string;
  hostname: string;
  title: string;
  description: string;
}
/** Only extract candidates. The server independently validates DNS and network destinations. */
export function firstPreviewLink(body: string) {
  return body.match(/https:\/\/[^\s<>]+/i)?.[0].replace(/[),.!?;]+$/, "");
}
export function previewLink(api: Api, url: string) {
  return api.get<LinkPreview>(`/api/embeds?url=${encodeURIComponent(url)}`);
}
