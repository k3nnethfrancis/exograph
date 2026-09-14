import { AGENT_ICON_MAX_DIMENSION, normalizeAgentCommandAppearance } from "@exograph/core/agent-command-configuration";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Read only the file explicitly selected by the user, then discard its metadata. */
export async function importAgentCommandIcon(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Choose an image smaller than 2 MB.");
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("Choose a PNG or JPEG image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Choose another PNG or JPEG.");
  }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096) {
      throw new Error("Choose an image no larger than 4096 × 4096 pixels.");
    }
    const scale = Math.min(1, AGENT_ICON_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable. Try again.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const iconDataUrl = canvas.toDataURL("image/png");
    if (!normalizeAgentCommandAppearance({ iconDataUrl })?.iconDataUrl) {
      throw new Error("This icon is too detailed. Choose a simpler image.");
    }
    return iconDataUrl;
  } finally {
    bitmap.close();
  }
}
