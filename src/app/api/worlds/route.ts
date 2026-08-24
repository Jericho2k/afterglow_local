import { randomUUID } from "node:crypto";
import { asUser, worldFromRow, worldSummaryFromRow } from "@/lib/db";
import { richFieldPayload } from "@/lib/rich-content";
import { worldSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The Worlds hub.
 *
 * Three scopes over one table, because "worlds I made", "worlds I saved" and
 * "worlds anybody published" are three questions about the same objects rather
 * than three collections. Each answers in a single statement and each selects
 * card columns only — a listing never carries lore, so a page of world cards
 * cannot become a page of canon documents and a private world's content has no
 * route to a public surface.
 *
 * `mine` is the default so the studio's world picker, which has always called
 * this endpoint bare, keeps receiving exactly what it did.
 */

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const scope = new URL(request.url).searchParams.get("scope") ?? "mine";

  const worlds = await asUser(account.id, async (client) => {
    const columns = `w.id,w.user_id,w.name,w.description,w.cover_path,w.cover_url,w.visibility,w.save_count,w.created_at,w.updated_at,
      (mine.world_id IS NOT NULL) saved_by_viewer,
      p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path`;
    const joins = `LEFT JOIN world_saves mine ON mine.world_id=w.id AND mine.user_id=$1
      LEFT JOIN profiles p ON p.id=w.user_id`;

    /**
     * How many creations use each world on this page.
     *
     * One grouped statement for the whole page rather than a count per card,
     * and only creations the viewer may actually see are counted — so a
     * private creation can never be inferred from a number on a public card.
     */
    async function withCounts(rows: Record<string, unknown>[]) {
      const pageIds = rows.map((row) => String(row.id));
      if (!pageIds.length) return rows;
      // Explicit placeholders rather than `= ANY($1::uuid[])`: the array form
      // is fine in PostgreSQL but unsupported by the in-memory engine the
      // tests run against, and a query shape that cannot be tested is worse
      // than a slightly longer one. The page is capped at 60, so is this.
      const placeholders = pageIds.map((_, index) => `$${index + 2}`).join(",");
      const counts = await client.query(
        `SELECT cw.world_id, count(*)::int count
         FROM character_worlds cw
         JOIN characters c ON c.id=cw.character_id
         WHERE cw.world_id IN (${placeholders}) AND (c.user_id=$1 OR c.visibility='public')
         GROUP BY cw.world_id`,
        [account!.id, ...pageIds],
      );
      const byWorld = new Map(counts.rows.map((row) => [String(row.world_id), Number(row.count)]));
      return rows.map((row) => ({ ...row, creation_count: byWorld.get(String(row.id)) ?? 0 }));
    }

    if (scope === "discover") {
      // Published worlds from everybody, the caller's own included: a creator
      // who published a world should find it where everybody else does.
      const result = await client.query(
        `SELECT ${columns} FROM worlds w ${joins}
         WHERE w.visibility='public'
         ORDER BY w.save_count DESC, w.updated_at DESC, w.id DESC LIMIT 60`,
        [account.id],
      );
      return (await withCounts(result.rows)).map((row) => worldSummaryFromRow(row, account.id));
    }

    if (scope === "saved") {
      // A save row is the caller's own and RLS enforces that independently.
      // The join to `worlds` re-checks readability, so a world that went
      // private after being saved drops out rather than leaking.
      const result = await client.query(
        `SELECT ${columns} FROM world_saves s
         JOIN worlds w ON w.id=s.world_id AND (w.user_id=$1 OR w.visibility IN ('public','unlisted'))
         ${joins}
         WHERE s.user_id=$1
         ORDER BY s.created_at DESC LIMIT 60`,
        [account.id],
      );
      return (await withCounts(result.rows)).map((row) => worldSummaryFromRow(row, account.id));
    }

    const result = await client.query(
      `SELECT ${columns} FROM worlds w ${joins} WHERE w.user_id=$1 ORDER BY w.updated_at DESC`,
      [account.id],
    );
    return (await withCounts(result.rows)).map((row) => ({
      ...worldSummaryFromRow(row, account.id),
      // The studio's world picker reads this name; kept so attaching a world
      // to a creation works exactly as it did.
      characterCount: Number(row.creation_count || 0),
    }));
  });

  return Response.json({ worlds });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const id = randomUUID(); const value = parsed.data;
  // Text and blocks are written from one place, so the column a prompt reads
  // and the column a page renders can never disagree about what the lore says.
  const lore = richFieldPayload(value.contentRich.length ? value.contentRich : [{ type: "text", text: value.content }]);
  const result = await asUser(account.id, (client) => client.query(
    `INSERT INTO worlds (id,user_id,name,description,content,content_rich,visibility,cover_path,cover_url)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
    [id,account.id,value.name,value.description,lore.text || value.content,JSON.stringify(lore.rich),value.visibility,value.coverPath,value.coverUrl],
  ));
  return Response.json({ world: worldFromRow(result.rows[0], account.id) }, { status: 201 });
}
