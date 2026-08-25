import { asUser, characterFromRow, worldSummaryFromRow } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import { withCastMemberIds } from "@/lib/cast";
import { richFieldPayload, textToRich, type RichBlock } from "@/lib/rich-content";
import { currentAccount, unauthorized } from "@/lib/session";
import { visitorCharacter } from "@/lib/access";


/**
 * The rich fields, reconciled.
 *
 * `richFieldPayload` decides both halves of each pair at once: the text a
 * prompt will read, and the blocks a page will render. A field whose blocks
 * say nothing the text does not goes back to being plain, so a description
 * nobody put a picture in is stored exactly as it always was.
 */
function richFields(c: { description: string; descriptionRich: RichBlock[]; greeting: string; greetingRich: RichBlock[]; alternateGreetings: string[]; alternateGreetingsRich: RichBlock[][] }) {
  const description = richFieldPayload(c.descriptionRich.length ? c.descriptionRich : textToRich(c.description));
  const greeting = richFieldPayload(c.greetingRich.length ? c.greetingRich : textToRich(c.greeting));
  const openings = c.alternateGreetings.map((opening, index) => {
    const blocks = c.alternateGreetingsRich[index] ?? [];
    return richFieldPayload(blocks.length ? blocks : textToRich(opening));
  });
  return {
    description: description.text,
    descriptionRich: JSON.stringify(description.rich),
    greeting: greeting.text,
    greetingRich: JSON.stringify(greeting.rich),
    // Index-aligned with the text array, so an opening and its blocks can
    // never drift apart by one.
    alternateGreetings: JSON.stringify(openings.map((opening) => opening.text).filter(Boolean)),
    alternateGreetingsRich: JSON.stringify(openings.filter((opening) => opening.text).map((opening) => opening.rich)),
  };
}

/*
 * Whether this database has the locked-world preview function yet.
 *
 * Probed once per process, in a transaction of its own. That isolation is the
 * point: PostgreSQL aborts a transaction after any failed statement, so
 * calling a function that does not exist inside the page's own transaction
 * would take the rest of the request down with it. A deployment that has not
 * run 0017 therefore keeps exactly its previous behaviour — readable worlds
 * show, locked ones do not — instead of failing the page. Like the row level
 * security probe in `db.ts`, the answer is cached until the process restarts.
 */
let previewFunctionSupported: boolean | null = null;

export function resetWorldPreviewSupportForTesting() {
  if (process.env.NODE_ENV !== "test") throw new Error("Preview support reset is test-only");
  previewFunctionSupported = null;
}

async function worldPreviewsSupported(userId: string) {
  if (previewFunctionSupported !== null) return previewFunctionSupported;
  try {
    await asUser(userId, (client) => client.query(
      "SELECT id FROM creation_world_previews($1) LIMIT 0",
      ["00000000-0000-0000-0000-000000000000"],
    ));
    previewFunctionSupported = true;
  } catch {
    previewFunctionSupported = false;
  }
  return previewFunctionSupported;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  const supportsPreviews = await worldPreviewsSupported(account.id);
  const detail = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.*,p.id creator_id,p.username creator_username,p.display_name creator_display_name,
         p.avatar_path creator_avatar_path,(mine.character_id IS NOT NULL) saved_by_viewer
       FROM characters c
       LEFT JOIN profiles p ON p.id=c.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$2
       WHERE c.id=$1 AND (c.user_id=$2 OR c.visibility IN ('public','unlisted'))`,
      [id, account.id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const owner = String(row.user_id) === account.id;
    /*
     * The worlds this viewer may actually open — as cards, never as documents.
     *
     * Row level security answers who may open one: a world resolves here when
     * it is public, unlisted, or the viewer's own, which is what keeps an
     * owner's private world openable on their own creation page. The CASE
     * masks are kept as a second layer, so a policy mistake still cannot ship
     * a description through this route. Worlds the viewer may NOT open are
     * handled separately below, because RLS correctly refuses to return them.
     *
     * `content` and `content_rich` are deliberately absent from this list.
     * This page draws a cover, a name and one line of description; it has
     * never rendered lore. Selecting it anyway meant a creation attached to a
     * hundred-thousand-character world shipped that document on every view of
     * every card, which is the single largest cost this page used to carry.
     * The lore lives one link away, on the world's own page, where it is read.
     */
    const worlds = await client.query(
      `SELECT w.id,w.name,w.cover_path,w.cover_url,
         (w.user_id=$2 OR w.visibility IN ('public','unlisted')) readable,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.description ELSE '' END description,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.visibility ELSE 'private' END visibility,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.save_count ELSE 0 END save_count,
         w.user_id,w.created_at,w.updated_at
       FROM worlds w
       JOIN character_worlds cw ON cw.world_id=w.id
       WHERE cw.character_id=$1
       ORDER BY w.updated_at DESC`,
      [id, account.id],
    );
    // This is deliberately viewer-scoped. A public character page must never
    // expose another account's private stories, even as an aggregate.
    const messages = await client.query(
      `SELECT COUNT(DISTINCT COALESCE(m.authored_event_id,m.id))::int count
       FROM messages m JOIN conversations v ON v.id=m.conversation_id
       WHERE m.user_id=$1 AND v.user_id=$1 AND v.character_id=$2 AND m.role='user'
         AND m.generation_started_at IS NOT NULL`,
      [account.id, id],
    );
    /*
     * The links the reader may not open.
     *
     * The query above can only ever see worlds this account is permitted to
     * read — `worlds_select_own_or_published` is doing exactly its job — which
     * is why a public creation built on somebody's private world used to show
     * no world at all. The association is real and hiding it misrepresents the
     * creation, so the ids and covers come from a preview function that
     * returns four columns and no lore; see 0017_linked_world_previews.sql for
     * why the narrowness is structural rather than careful.
     */
    const previews = supportsPreviews
      ? (await client.query("SELECT id,name,cover_path,cover_url FROM creation_world_previews($1)", [id])).rows.map((preview) => ({
        id: String(preview.id), name: String(preview.name),
        coverPath: String(preview.cover_path || ""), coverUrl: String(preview.cover_url || ""),
      }))
      : [];
    // Anything the query returned is already accounted for, readable or not.
    // The previews only supply worlds row level security refused to return.
    const returnedIds = new Set(worlds.rows.map((world) => String(world.id)));
    const lockedPreviews = previews.filter((preview) => !returnedIds.has(preview.id));

    // World links the creator may edit. A locked world is still linked, so it
    // still counts — the studio must not silently detach it on the next save.
    const worldIds = previews.length
      ? previews.map((preview) => preview.id)
      : worlds.rows.map((world) => String(world.id));
    // Gallery rows are readable wherever the character is, so a visitor sees a
    // published character's gallery without ever reaching its owner's stories.
    const gallery = await client.query(
      "SELECT id,storage_path,external_url,caption,position FROM character_gallery WHERE character_id=$1 ORDER BY position ASC, created_at ASC",
      [id],
    );
    const character = characterFromRow({ ...row, world_ids: worldIds, gallery: gallery.rows }, account.id);
    return {
      // A visitor receives the public creation, not its prompt engineering.
      character: owner ? character : visitorCharacter(character),
      worlds: [
        // The second layer: even if a policy change ever let an unreadable row
        // through the query above, it still leaves here as a locked card.
        ...worlds.rows.map((row) => row.readable
          ? worldSummaryFromRow(row, account.id)
          : { id: String(row.id), name: String(row.name), coverPath: String(row.cover_path || ""), coverUrl: String(row.cover_url || ""), locked: true as const }),
        // Identity and a cover. No lore, no description, no creator, no
        // comments, no timestamps — there is nothing else in the row to leak.
        ...lockedPreviews.map((preview) => ({ ...preview, locked: true as const })),
      ],
      viewerMessageCount: Number(messages.rows[0]?.count || 0),
      owner,
    };
  });

  if (!detail) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json(detail);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;
  const rich = richFields(c);

  const row = await asUser(account.id, async (client) => {
    // user_id in the predicate means a request naming somebody else's
    // character updates nothing rather than being silently accepted.
    const result = await client.query(
      `UPDATE characters SET name=$1,profile_type=$2,tagline=$3,avatar_url=$4,avatar_path=$5,accent=$6,backstory=$7,cast_members=$8::jsonb,lorebook='',personality=$9,scenario=$10,greeting=$11,alternate_greetings=$12::jsonb,example_dialogue=$13,response_directive=$14,boundaries=$15,source_material=$16,nsfw_enabled=$17,visibility=$18,tags=$21::text[],quick_facts=$22::jsonb,
         creation_type=$23,title=$24,description=$25,user_role=$26,hashtags=$27::text[],
         description_rich=$28::jsonb,greeting_rich=$29::jsonb,alternate_greetings_rich=$30::jsonb,
         published_at=CASE WHEN $18='public' AND published_at IS NULL THEN now() WHEN $18<>'public' THEN NULL ELSE published_at END,
         updated_at=now()
       WHERE id=$19 AND user_id=$20 RETURNING *`,
      [c.name,c.profileType,c.tagline,c.avatarUrl,c.avatarPath,c.accent,c.backstory,JSON.stringify(withCastMemberIds(c.cast)),c.personality,c.scenario,rich.greeting,rich.alternateGreetings,c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,c.visibility,id,account.id,c.tags,JSON.stringify(c.quickFacts),c.creationType,c.title,rich.description,c.userRole,c.hashtags,rich.descriptionRich,rich.greetingRich,rich.alternateGreetingsRich],
    );
    if (!result.rowCount) return null;
    await client.query("DELETE FROM character_worlds WHERE character_id=$1", [id]);
    for (const worldId of c.worldIds) {
      await client.query(
        "INSERT INTO character_worlds (character_id,world_id) SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM worlds WHERE id=$2 AND user_id=$3) ON CONFLICT DO NOTHING",
        [id,worldId,account.id],
      );
    }
    const links = await client.query("SELECT world_id FROM character_worlds WHERE character_id=$1", [id]);
    return { row: result.rows[0], worldIds: links.rows.map((link) => String(link.world_id)) };
  });

  if (!row) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ character: characterFromRow({ ...row.row, world_ids: row.worldIds }, account.id) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  try {
    const deleted = await asUser(account.id, (client) => client.query("DELETE FROM characters WHERE id=$1 AND user_id=$2", [id, account.id]));
    if (!deleted.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    // The database refuses to cascade a published character's deletion into
    // other accounts' private chats. Surface that as a conflict to resolve
    // rather than a server error.
    if (error instanceof Error && error.message.includes("character_in_use_by_other_accounts")) {
      return Response.json(
        { error: "Other accounts are chatting with this character. Set it back to private instead of deleting it." },
        { status: 409 },
      );
    }
    throw error;
  }
}
