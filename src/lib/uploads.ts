import { supabaseBrowser } from "./supabase/client";
import { isRenderableImageType } from "./og-artwork";
import { avatarObjectPath } from "./storage";

/**
 * Uploads an image to Supabase Storage and returns its object path.
 *
 * The path is scoped by account id, which is what the storage policies check,
 * so the browser cannot write into another account's folder even though it
 * performs the upload directly.
 */

/** What a creator may choose from. Unchanged: this is not the renderer's list. */
const acceptedTypes = /^image\/(png|jpeg|webp|gif)$/;

export const maxUploadBytes = 5_000_000;

/**
 * The longest edge an artwork upload is reduced to before re-encoding.
 *
 * Only reached when a picture has to be re-encoded anyway. 2048 is comfortably
 * above every window the product draws — the widest is the 1200-pixel share
 * card — so nothing visible is lost, and it keeps a re-encode from turning a
 * small WebP into a PNG too large to store.
 */
const artworkEdge = 2048;

/**
 * Whether this file has to be converted before it can be a share card.
 *
 * The two lists differ and that is the whole bug: `acceptedTypes` is what a
 * creator may upload, `isRenderableImageType` is what the bundled card renderer
 * will actually draw. A WebP cover satisfied the first, failed the second, and
 * produced a card with no picture on it and no error anywhere — see
 * src/lib/og-artwork.ts. Converting at the door is what stops that happening
 * again for anything uploaded from now on.
 */
export function needsRenderableConversion(type: string) {
  return !isRenderableImageType(type);
}

/** The name the converted file takes, so the stored object keeps a true suffix. */
export function renderableFileName(name: string, type: string) {
  const stem = name.replace(/\.[^.]*$/, "") || "artwork";
  return `${stem}.${type === "image/png" ? "png" : "jpeg"}`;
}

/**
 * Re-encodes a picture the card renderer cannot draw.
 *
 * The browser already has decoders for every format the file picker accepts —
 * that is why a WebP cover looks right on the page — so the conversion is a
 * decode and an encode, with no library and no server round trip.
 *
 * Two decisions worth stating:
 *
 *   * PNG when the picture has transparency, JPEG when it does not. Encoding a
 *     photograph as PNG can make it several times larger than the original and
 *     push it past the storage limit; encoding a cut-out as JPEG puts a black
 *     box behind it. Neither is acceptable, so the alpha channel decides.
 *   * An animated GIF becomes its first frame. Every surface in the product
 *     draws this artwork as a static crop already — a card, a ranked row, a
 *     hero — so the frame is what a reader sees in all but one place, and a
 *     format the share card cannot draw at all is the worse trade.
 */
async function toRenderableFile(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    for (const edge of [artworkEdge, 1600, 1200]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser cannot convert that image. Upload a PNG or JPEG instead.");
      context.drawImage(bitmap, 0, 0, width, height);
      const type = hasTransparency(context, width, height) ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (!blob) throw new Error("This browser cannot convert that image. Upload a PNG or JPEG instead.");
      // Smaller edges are tried in turn rather than dropping the alpha channel:
      // a picture that is too large is a size problem, not a transparency one.
      if (blob.size <= maxUploadBytes) return new File([blob], renderableFileName(file.name, type), { type });
    }
    throw new Error("That image is too detailed to use for artwork. Try a smaller one.");
  } finally {
    bitmap.close();
  }
}

/** Whether any pixel is less than fully opaque. Decides the encoding above. */
function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true;
  }
  return false;
}

/**
 * @param renderable  True for artwork that may end up on a link preview — a
 *   cover, a banner, a nominated share image. Those are converted to a format
 *   the card renderer can draw; anything else is stored exactly as uploaded.
 */
export async function uploadImage(file: File, bucket: string, { renderable = false } = {}) {
  if (!acceptedTypes.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > maxUploadBytes) throw new Error("Images must be smaller than 5 MB.");
  const stored = renderable && needsRenderableConversion(file.type) ? await toRenderableFile(file) : file;
  const supabase = supabaseBrowser();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Sign in before uploading an image");
  const path = avatarObjectPath(userData.user.id, stored.name);
  const { error } = await supabase.storage.from(bucket).upload(path, stored, { cacheControl: "3600", upsert: false, contentType: stored.type });
  if (error) throw new Error(error.message);
  return path;
}
