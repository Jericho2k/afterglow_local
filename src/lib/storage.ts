export const profileAvatarBucket = "profile-avatars";
export const characterAvatarBucket = "character-avatars";

/**
 * Where an avatar actually lives.
 *
 * A Storage object path wins when present. Otherwise the legacy `avatarUrl`
 * is used unchanged, which keeps imported character cards pointing at their
 * original external image and keeps pre-migration inline data URIs rendering.
 */
export function avatarSource(bucket: string, path: string, fallbackUrl: string) {
  if (!path) return fallbackUrl;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return fallbackUrl;
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${path}`;
}

/** Object key for a new upload, always scoped to the owning account. */
export function avatarObjectPath(userId: string, fileName: string) {
  const extension = /\.(png|jpe?g|webp|gif)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "png";
  return `users/${userId}/avatars/${crypto.randomUUID()}.${extension === "jpg" ? "jpeg" : extension}`;
}
