import { artPresentationDocument } from "@/lib/art-presentation";
import { asUser, characterFromRow, worldSummaryFromRow } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import { withCastMemberIds } from "@/lib/cast";
import { richFieldPayload, textToRich, type RichBlock } from "@/lib/rich-content";
import { currentAccount, unauthorized } from "@/lib/session";
import { visitorCharacter } from "@/lib/access";
import { effectiveBorder } from "@/lib/cosmetics";
import { bestRankBadge } from "@/lib/rankings";
import { creationRanks } from "@/lib/ranking-store";


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

  /*
   * The verbatim import source, requested rather than assumed.
   *
   * `source_material` is up to 100,000 characters of Paste Everything input per
   * creation. The editor genuinely needs it — saving without it would blank the
   * creator's original paste — and nothing else does. Selecting it
   * unconditionally meant every visit to a creation's own page, by its owner,
   * downloaded a document the page does not render, on the slowest surface in
   * the product. It is now opt-in, and row level security still decides whether
   * the row is readable at all.
   */
  const wantsEditPayload = new URL(_request.url).searchParams.get("scope") === "edit";
  const supportsPreviews = await worldPreviewsSupported(account.id);
  const detail = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT ${wantsEditPayload ? "c.*" : "c.id,c.user_id,c.name,c.profile_type,c.creation_type,c.title,c.tagline,c.description,c.user_role,c.avatar_url,c.avatar_path,c.accent,c.backstory,c.cast_members,c.lorebook,c.personality,c.scenario,c.greeting,c.alternate_greetings,c.description_rich,c.greeting_rich,c.alternate_greetings_rich,c.example_dialogue,c.response_directive,c.boundaries,c.tags,c.hashtags,c.quick_facts,c.content_mode,c.nsfw_enabled,c.share_title,c.share_tagline,c.share_image_path,c.share_image_url,c.share_media_status,c.banner_path,c.banner_url,c.art_presentation,c.visibility,c.moderation_status,c.moderation_reason,c.like_count,c.chat_count,c.message_count,c.published_at,c.created_at,c.updated_at"},p.id creator_id,p.username creator_username,p.display_name creator_display_name,
         p.avatar_path creator_avatar_path,p.profile_border creator_border,
         COALESCE(p.follower_count,0) creator_followers,
         COALESCE(cs.user_messages,0) creator_messages,COALESCE(cs.published_creations,0) creator_creations,
         COALESCE(cs.published_worlds,0) creator_worlds,cs.rank creator_rank,COALESCE(cs.rank_total,0) creator_rank_total,
         (follows.creator_user_id IS NOT NULL) creator_followed,
         (mine.character_id IS NOT NULL) saved_by_viewer
       FROM characters c
       LEFT JOIN profiles p ON p.id=c.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       LEFT JOIN creator_stats cs ON cs.user_id=c.user_id
       LEFT JOIN profile_follows follows ON follows.creator_user_id=c.user_id AND follows.follower_user_id=$2
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
     * The story this reader is already in, if any.
     *
     * The creation page's main button used to create a conversation every time
     * it was pressed. It resumes now, and this is the one fact it needs to do
     * that: the newest story this account has with this creation. Ordered by
     * the same `updated_at` the Chats list and `GET /api/conversations` order
     * by, so "most recent" means one thing across the product.
     *
     * Viewer-scoped and indexed (`conversations_character_idx`, and the row
     * level security predicate is `user_id = auth.uid()`), so it can never
     * describe anybody else's stories and costs one indexed lookup.
     */
    const ownStories = await client.query(
      `SELECT id,updated_at,(SELECT count(*)::int FROM conversations WHERE character_id=$1 AND user_id=$2) total
       FROM conversations WHERE character_id=$1 AND user_id=$2
       ORDER BY updated_at DESC,created_at DESC LIMIT 1`,
      [id, account.id],
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
    /*
     * The gallery, and where this creation stands.
     *
     * Issued together because they are independent and this is the slowest page
     * in the product: the standing is a precomputed lookup on
     * `creation_rankings_creation_idx` returning at most a handful of rows, and
     * it must not become a second round trip stacked on top of the six this
     * page already makes.
     *
     * Gallery rows are readable wherever the character is, so a visitor sees a
     * published character's gallery without ever reaching its owner's stories.
     */
    const [gallery, ranks] = await Promise.all([
      client.query(
        "SELECT id,storage_path,external_url,caption,position FROM character_gallery WHERE character_id=$1 ORDER BY position ASC, created_at ASC",
        [id],
      ),
      creationRanks(client, id),
    ]);
    /*
     * The creator, as a card.
     *
     * Three public totals, a ring, a follow control and — only for the top
     * hundred — a medal. Deliberately a SUMMARY: the profile is one tap away
     * and is where achievements, activity, worlds and the full standing live.
     *
     * Every field comes from the joins on the query above rather than from
     * queries of its own. That matters on this page in particular: it is the
     * slowest surface in the product and the last sprint spent its time taking
     * round trips OUT of it, so a creator card that added four would be undoing
     * that work to draw three numbers. The standing itself is precomputed —
     * `creator_stats` is refreshed by whoever opens a profile page, not by
     * everybody who opens a creation.
     *
     * The card is built whenever the profile row RESOLVED, and no longer
     * requires a username. That condition is the whole of the "the creator is
     * invisible to everybody but the creator" report: an account that never
     * chose a handle had no publicly readable profile, so this join produced
     * NULL for every visitor and a row for the owner, and the page drew its
     * whole creator section conditionally on it. 0022 gives every publishing
     * account a handle, and this stops depending on one — a creation whose
     * creator somehow has no profile page still says who made it, with the
     * link and the follow control simply absent.
     */
    // A creation always has an owner, even if an old account somehow missed
    // the profile backfill.  Identity must therefore come from the creation's
    // non-null owner column, not from the optional public-profile join.
    const creatorId = String(row.user_id || "");
    const standing = {
      followers: Number(row.creator_followers || 0),
      userMessages: Number(row.creator_messages || 0),
      publishedCreations: Number(row.creator_creations || 0),
      publishedWorlds: Number(row.creator_worlds || 0),
      rank: row.creator_rank == null ? null : Number(row.creator_rank),
      rankTotal: Number(row.creator_rank_total || 0),
    };
    const creatorCard = creatorId ? {
      id: creatorId,
      username: String(row.creator_username || ""),
      displayName: String(row.creator_display_name || "Afterglow creator"),
      avatarPath: String(row.creator_avatar_path || ""),
      followers: standing.followers,
      messages: standing.userMessages,
      creations: standing.publishedCreations,
      rank: standing.rank,
      rankTotal: standing.rankTotal,
      border: effectiveBorder(String(row.creator_border || "default"), {
        followers: standing.followers, messages: standing.userMessages,
        publishedCreations: standing.publishedCreations, publishedWorlds: standing.publishedWorlds,
        rank: standing.rank,
      }, standing.rankTotal),
      viewerFollows: Boolean(row.creator_followed),
      owner: creatorId === account.id,
    } : null;
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
      // Null when this reader has never started one. The page uses the
      // presence of a story to decide between Start and Continue; see
      // `chatCta` in src/lib/creation-actions.ts.
      viewerConversationId: ownStories.rows[0] ? String(ownStories.rows[0].id) : null,
      viewerConversationCount: Number(ownStories.rows[0]?.total || 0),
      creatorCard,
      /*
       * One rank, chosen by the rule in src/lib/rankings.ts.
       *
       * Chosen HERE rather than in the browser so the page cannot be handed
       * four ranks and decide for itself which to draw — the badge on a
       * creation page, the badge on a ranked row and anything that grows one
       * later all read the same selection.
       *
       * Only for a public creation. A private or unlisted one is not on a
       * board, and a stale row for a creation that has since been unpublished
       * must not put a position on a page that nobody else can see.
       */
      rankBadge: row.visibility === "public" ? bestRankBadge(ranks) : null,
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
  const moderation=await asUser(account.id,(client)=>client.query("SELECT moderation_status,moderation_reason FROM characters WHERE id=$1 AND user_id=$2",[id,account.id]));
  if(moderation.rows[0]?.moderation_status==="removed")return Response.json({error:"This creation was removed by Afterglow and is locked from editing or republishing while moderation is active."},{status:423});
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;
  const rich = richFields(c);

  const row = await asUser(account.id, async (client) => {
    /*
     * A classification approves AN IMAGE, so changing the image withdraws it.
     *
     * `share_media_status` is absent from `characterSchema`, so a payload
     * cannot set it — and that was only ever half the rule. Without the reset
     * below, a creator could have their cover approved for external previews
     * and then swap in anything at all: the row would still say `safe`, and the
     * new file would go straight into a Discord embed with nobody having looked
     * at it.
     *
     * The comparison collapses the row to the ONE image that would actually be
     * published, in the order `nominatedMedia` resolves it — a dedicated share
     * image, then a share URL, then the cover. So re-cropping a cover that
     * nothing nominates does not cost a creator their approved share image, and
     * replacing the image that IS nominated always does.
     *
     * It happens inside the UPDATE rather than across a read and a write, where
     * bare column names mean the row as it stands BEFORE this statement. A
     * moderator approving at the same moment therefore cannot be overwritten by
     * a status this request read a moment earlier.
     */
    // user_id in the predicate means a request naming somebody else's
    // character updates nothing rather than being silently accepted.
    const result = await client.query(
      `UPDATE characters SET name=$1,profile_type=$2,tagline=$3,avatar_url=$4,avatar_path=$5,accent=$6,backstory=$7,cast_members=$8::jsonb,lorebook='',personality=$9,scenario=$10,greeting=$11,alternate_greetings=$12::jsonb,example_dialogue=$13,response_directive=$14,boundaries=$15,source_material=$16,nsfw_enabled=$17,visibility=$18,tags=$21::text[],quick_facts=$22::jsonb,
         creation_type=$23,title=$24,description=$25,user_role=$26,hashtags=$27::text[],
         description_rich=$28::jsonb,greeting_rich=$29::jsonb,alternate_greetings_rich=$30::jsonb,
         content_mode=$31,share_title=$32,share_tagline=$33,share_image_path=$34,share_image_url=$35,
         banner_path=$36,banner_url=$37,art_presentation=$38::jsonb,
         share_media_status=CASE WHEN
             (CASE WHEN share_image_path<>'' THEN share_image_path WHEN share_image_url<>'' THEN share_image_url WHEN avatar_path<>'' THEN avatar_path ELSE avatar_url END)
             = (CASE WHEN $34<>'' THEN $34 WHEN $35<>'' THEN $35 WHEN $5<>'' THEN $5 ELSE $4 END)
           THEN share_media_status ELSE 'unreviewed' END,
         published_at=CASE WHEN $18='public' AND published_at IS NULL THEN now() WHEN $18<>'public' THEN NULL ELSE published_at END,
         updated_at=now()
       WHERE id=$19 AND user_id=$20 RETURNING *`,
      [c.name,c.profileType,c.tagline,c.avatarUrl,c.avatarPath,c.accent,c.backstory,JSON.stringify(withCastMemberIds(c.cast)),c.personality,c.scenario,rich.greeting,rich.alternateGreetings,c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.contentMode!=="clean",c.visibility,id,account.id,c.tags,JSON.stringify(c.quickFacts),c.creationType,c.title,rich.description,c.userRole,c.hashtags,rich.descriptionRich,rich.greetingRich,rich.alternateGreetingsRich,c.contentMode,c.shareTitle,c.shareTagline,c.shareImagePath,c.shareImageUrl,c.bannerPath,c.bannerUrl,JSON.stringify(artPresentationDocument(c.artPresentation))],
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
