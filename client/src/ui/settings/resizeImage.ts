/** Largest image the server stores for an avatar or icon. Mirrors MAX_ICON_BYTES in server/src/image_blob.rs. */
export const MAX_IMAGE_BYTES = 512 * 1024;

/** Scale (width, height) down to fit inside a max x max box, keeping the aspect ratio. Never scales up. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decodes an image file and re-encodes it as a small WebP (PNG where the browser cannot encode WebP).
 * Keeps avatars and icons far below the server's 512 KB limit and drops metadata such as GPS tags.
 */
export async function resizeImage(file: Blob, max = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize images");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.85));
    if (!blob) throw new Error("This image could not be prepared");
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("This image is too large");
    return blob;
  } finally {
    bitmap.close();
  }
}
