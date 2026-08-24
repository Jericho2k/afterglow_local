import { asUser, characterFromRow, worldFromRow } from "@/lib/db";
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

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

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
     * Every attached world, including ones this viewer may not open.
     *
     * A public creation built on a private world is still built on it, and
     * hiding the association would misrepresent what the creation is. So the
     * association is shown and the content is not: a world the viewer cannot
     * read comes back as `locked`, carrying its id, its name and its cover and
     * nothing else — no lore, no description, no creator, no comments, no
     * timestamps. The readable case is decided in SQL rather than by trimming
     * a fully-selected row afterwards, so there is no full row to forget to
     * trim.
     */
    const worlds = await client.query(
      `SELECT w.id,w.name,w.cover_path,w.cover_url,
         (w.user_id=$2 OR w.visibility IN ('public','unlisted')) readable,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.description ELSE '' END description,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.content ELSE '' END content,
         CASE WHEN w.user_id=$2 OR w.visibility IN ('public','unlisted') THEN w.content_rich ELSE '[]'::jsonb END content_rich,
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
    // World links the creator may edit. A locked world is still linked, so it
    // still counts — the studio must not silently detach it on the next save.
    const worldIds = worlds.rows.map((world) => String(world.id));
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
      worlds: worlds.rows.map((row) => row.readable
        ? worldFromRow(row, account.id)
        : { id: String(row.id), name: String(row.name), coverPath: String(row.cover_path || ""), coverUrl: String(row.cover_url || ""), locked: true as const }),
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
