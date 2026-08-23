import { supabaseBrowser } from "./supabase/client";
import { avatarObjectPath } from "./storage";

/**
 * Uploads an image to Supabase Storage and returns its object path.
 *
 * The path is scoped by account id, which is what the storage policies check,
 * so the browser cannot write into another account's folder even though it
 * performs the upload directly.
 */
export async function uploadImage(file: File, bucket: string) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 5_000_000) throw new Error("Images must be smaller than 5 MB.");
  const supabase = supabaseBrowser();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Sign in before uploading an image");
  const path = avatarObjectPath(userData.user.id, file.name);
  const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}
