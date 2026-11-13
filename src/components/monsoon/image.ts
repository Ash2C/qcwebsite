// Shrinks a camera photo before upload. A phone JPEG is several MB and the server accepts at
// most 3.7 MB; a photo of several cards needs more pixels than one card (2400 px long side).
// If the first encode is over maxBytes, re-encode at lower quality, then at a smaller size.
// Needs a real canvas, so it is not covered by the jsdom unit tests.
export async function downsizeImage(
  file: File,
  maxSide = 2400,
  quality = 0.8,
  maxBytes = 3_600_000,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");

    // Draws the bitmap at the given scale and encodes the canvas as JPEG.
    const encode = (s: number, q: number) => {
      canvas.width = Math.max(1, Math.round(bitmap.width * s));
      canvas.height = Math.max(1, Math.round(bitmap.height * s));
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the photo"))),
          "image/jpeg",
          q,
        );
      });
    };

    let blob = await encode(scale, quality);
    if (blob.size > maxBytes) {
      blob = await encode(scale, 0.6);
    }
    if (blob.size > maxBytes) {
      // If this third encode is still over the limit it is returned as is and the server answers 413.
      blob = await encode(scale * 0.75, 0.6);
    }
    return blob;
  } finally {
    bitmap.close();
  }
}
