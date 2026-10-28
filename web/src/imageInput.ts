export const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
export function clipboardImages(
  clipboard: Pick<DataTransfer, "files" | "items">,
): File[] {
  const files = Array.from(clipboard.files ?? []);
  if (!files.length)
    for (const item of Array.from(clipboard.items ?? [])) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  return files.filter((file) => file.type in IMAGE_EXTENSIONS);
}
export async function normalizeImage(file: File): Promise<File> {
  if (!(file.type in IMAGE_EXTENSIONS))
    throw new Error("Choose a PNG, JPEG, WebP, GIF or BMP image.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Images must be 10 MiB or smaller.");
  if (file.type !== "image/bmp") return file;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not decode this image.");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Could not convert this image.")),
        "image/png",
      ),
    );
    if (blob.size > 10 * 1024 * 1024)
      throw new Error("Converted image exceeds 10 MiB.");
    return new File([blob], file.name.replace(/\.bmp$/i, ".png"), {
      type: "image/png",
    });
  } finally {
    bitmap.close();
  }
}
