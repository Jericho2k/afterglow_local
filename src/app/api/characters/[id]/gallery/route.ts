import { randomUUID } from "node:crypto";
import { ownedCharacter } from "@/lib/access";
import { asUser } from "@/lib/db";
import { gallerySchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Replaces a character's gallery in one call.
 *
 * Ownership is checked here and enforced again by the composite foreign key on
 * character_gallery, so a request naming somebody else's character cannot
 * attach images to it even if this predicate were removed.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = gallerySchema.safeParse({ ...(await request.json().catch(() => ({}))), characterId: id });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid gallery" }, { status: 400 });

  const images = parsed.data.images.filter((image) => image.storagePath || image.externalUrl);

  const saved = await asUser(account.id, async (client) => {
    if (!(await ownedCharacter(client, account.id, id))) return null;
    await client.query("DELETE FROM character_gallery WHERE character_id=$1 AND user_id=$2", [id, account.id]);
    for (const [position, image] of images.entries()) {
      await client.query(
        "INSERT INTO character_gallery (id,character_id,user_id,storage_path,external_url,caption,position) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), id, account.id, image.storagePath, image.externalUrl, image.caption, position],
      );
    }
    const result = await client.query(
      "SELECT id,storage_path,external_url,caption,position FROM character_gallery WHERE character_id=$1 ORDER BY position ASC",
      [id],
    );
    return result.rows;
  });

  if (!saved) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ images: saved });
}
