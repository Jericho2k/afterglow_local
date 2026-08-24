import { randomUUID } from "node:crypto";
import { asUser, characterFromRow, ownedCreationFromRow } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";
import { characterFromSnapshot, visitorCharacter } from "@/lib/access";

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const scope = new URL(request.url).searchParams.get("scope");

  /**
   * The owner's management list.
   *
   * Your Creations renders a page of cards and needs a page of card data, so
   * this reads the same lean columns discovery does plus visibility and the
   * last-updated time. The hidden definition — greeting, personality,
   * backstory, response directive, boundaries, cast definitions, import
   * source — is not selected, which is both the privacy boundary and the
   * reason a creator with fifty creations does not download all of them to
   * look at a grid. Editing fetches the whole record for one creation.
   */
  if (scope === "manage") {
    const creations = await asUser(account.id, async (client) => {
      const result = await client.query(
        `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
           c.tags,c.hashtags,c.nsfw_enabled,c.visibility,c.message_count,c.chat_count,c.like_count,
           c.published_at,c.created_at,c.updated_at,
           p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path
         FROM characters c
         LEFT JOIN profiles p ON p.id=c.user_id
         WHERE c.user_id=$1
         ORDER BY c.updated_at DESC, c.id DESC`,
        [account.id],
      );
      return result.rows.map((row) => ownedCreationFromRow(row, account.id));
    });
    return Response.json({ creations });
  }

  const characters = await asUser(account.id, async (client) => {
    if (scope === "chats") {
      const conversations = await client.query(
        "SELECT character_id,character_snapshot FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC",
        [account.id],
      );
      const seen = new Set<string>();
      const ordered = conversations.rows.filter((row) => { const id=String(row.character_id); if(seen.has(id))return false; seen.add(id); return true; });
      const ids = ordered.map((row) => String(row.character_id));
      const live = ids.length ? await client.query("SELECT * FROM characters WHERE id = ANY($1::uuid[])",[ids]) : {rows:[] as Array<Record<string,unknown>>};
      const liveById = new Map(live.rows.map((row)=>[String(row.id),row]));
      return ordered.map((conversation) => {
        const id=String(conversation.character_id); const snapshot=conversation.character_snapshot;
        if(snapshot&&typeof snapshot==="object")return characterFromSnapshot(snapshot as Record<string,unknown>,id);
        const row=liveById.get(id); return row?characterFromRow({...row,world_ids:[]},account.id):null;
      }).filter((item): item is NonNullable<typeof item>=>Boolean(item));
    }
    // Discovery has its own endpoint, which returns lean public summaries
    // rather than whole characters; this route is the caller's own library.
    const result = await client.query("SELECT * FROM characters WHERE user_id=$1 ORDER BY updated_at DESC", [account.id]);
    const ids = result.rows.map((row) => String(row.id));
    const links = ids.length
      ? await client.query("SELECT character_id,world_id FROM character_worlds WHERE character_id = ANY($1::uuid[])", [ids])
      : { rows: [] as Array<Record<string, unknown>> };
    return result.rows.map((row) => {
      const character = characterFromRow({
        ...row,
        world_ids: links.rows.filter((link) => String(link.character_id) === String(row.id)).map((link) => String(link.world_id)),
      }, account.id);
      // Belt and braces: the predicate above already restricts this to the
      // caller's own rows, so anything else would be a bug worth blunting.
      return character.ownedByViewer ? character : visitorCharacter(character);
    });
  });

  return Response.json({ characters });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const id = randomUUID();
  const c = parsed.data;

  const row = await asUser(account.id, async (client) => {
    const result = await client.query(
      `INSERT INTO characters (id,user_id,name,profile_type,tagline,avatar_url,avatar_path,accent,backstory,cast_members,lorebook,personality,scenario,greeting,alternate_greetings,example_dialogue,response_directive,boundaries,source_material,nsfw_enabled,visibility,tags,quick_facts,creation_type,title,description,user_role,hashtags,published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'',$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21::text[],$22::jsonb,$23,$24,$25,$26,$27::text[],CASE WHEN $20='public' THEN now() ELSE NULL END) RETURNING *`,
      [id,account.id,c.name,c.profileType,c.tagline,c.avatarUrl,c.avatarPath,c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,c.visibility,c.tags,JSON.stringify(c.quickFacts),c.creationType,c.title,c.description,c.userRole,c.hashtags],
    );
    // Only the caller's own worlds may be attached; the insert policy rejects
    // anything else, and filtering here turns that into a clean no-op instead
    // of a failed request.
    for (const worldId of c.worldIds) {
      await client.query(
        "INSERT INTO character_worlds (character_id,world_id) SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM worlds WHERE id=$2 AND user_id=$3) ON CONFLICT DO NOTHING",
        [id,worldId,account.id],
      );
    }
    const links = await client.query("SELECT world_id FROM character_worlds WHERE character_id=$1", [id]);
    return { row: result.rows[0], worldIds: links.rows.map((link) => String(link.world_id)) };
  });

  return Response.json({ character: characterFromRow({ ...row.row, world_ids: row.worldIds }, account.id) }, { status: 201 });
}
