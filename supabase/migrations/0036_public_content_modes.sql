-- Content modes, share-safe media, and the anonymous read path.
--
-- Three things change, and they are deliberately three things rather than one.
--
-- 1. WHAT A CREATION IS ABOUT stops being a boolean. `nsfw_enabled` answered
--    "may this story go explicit?", and that single bit was then asked to also
--    answer "is this page suitable for a stranger who is not signed in?" Those
--    are different questions with different answers, and no boolean can hold
--    both:
--
--                     explicit roleplay    18+ presentation
--       clean               no                   no
--       adult_capable       yes                  no
--       adult_focused       yes                  yes
--
--    The middle row is the one the old model could not express, and it is most
--    of a catalogue: a story that stays clean unless its reader steers
--    otherwise was treated exactly like a page that exists to be pornographic
--    — hidden behind a login wall, absent from search, unshareable.
--
--    `content_mode` is therefore AUTHORITATIVE from this migration on. It is
--    not derived from the boolean and does not write back to it: explicit
--    roleplay is `content_mode <> 'clean'`, 18+ presentation is
--    `content_mode = 'adult_focused'`, and any code still reading
--    `nsfw_enabled` is reading a deprecated column that answers neither
--    question correctly for an adult_capable row.
--
-- 2. WHAT A CREATION SHOWS THE OUTSIDE WORLD becomes its own decision, and it
--    starts at NO for everything that already exists. Nothing in this database
--    was ever published under a promise about link previews, so no existing
--    image is assumed to be one — not even on a creation that was never marked
--    adult, because "not adult" was never the same claim as "suitable as an
--    unrestricted preview of an erotic-capable story on somebody's work
--    machine". Media becomes shareable by being nominated, and until it is,
--    the preview is a branded card.
--
-- 3. ANONYMOUS READS get a path of their own. Every route in the product
--    resolves an account first, which means a public creation page has never
--    been readable by a person who has not signed in — or by a crawler, or by
--    the thing that renders a link preview in a chat app. That is closed here
--    with narrow SECURITY DEFINER functions rather than by loosening a policy,
--    for the same structural reason 0017 gave: a function's RESULT TYPE is the
--    contract. A hidden field is not a column that was filtered out, it is a
--    column that does not exist in the result, so no caller can select it by
--    accident and no later edit can widen it by forgetting a predicate.

-- ---------------------------------------------------------------------------
-- Content mode
-- ---------------------------------------------------------------------------

ALTER TABLE characters ADD COLUMN IF NOT EXISTS content_mode text;

/*
 * The backfill is deliberately asymmetric, and it is a one-time translation
 * rather than a rule the system keeps applying.
 *
 * `nsfw_enabled = true` becomes adult_focused, not adult_capable, even though
 * adult_capable is the closer description of many of those creations. Two
 * reasons, and both point the same way. It preserves roleplay behaviour
 * exactly — those stories keep permission to go explicit. And it refuses to
 * publish: mapping to adult_capable would take content its creator marked 18+
 * under a one-bit model and expose it, that same day, to logged-out visitors
 * and search engines, without anyone having chosen that.
 *
 * A migration may quietly restrict. It may not quietly publish. Moving a
 * creation to adult_capable is a decision its creator makes afterwards, once,
 * knowing what it means.
 */
UPDATE characters
   SET content_mode = CASE WHEN nsfw_enabled THEN 'adult_focused' ELSE 'clean' END
 WHERE content_mode IS NULL;

ALTER TABLE characters ALTER COLUMN content_mode SET DEFAULT 'clean';
UPDATE characters SET content_mode = 'clean' WHERE content_mode IS NULL;
ALTER TABLE characters ALTER COLUMN content_mode SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_content_mode_allowed
    CHECK (content_mode IN ('clean','adult_capable','adult_focused'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/*
 * The old column stays for one release, and only so that a writer this release
 * has not yet updated does not fail against a NOT NULL column. It is not
 * maintained in step with `content_mode` by any trigger, because a trigger
 * would be this schema asserting that one bit can still answer both questions
 * — which is the thing that stops being true here. An adult_capable creation
 * has `nsfw_enabled = true` if some legacy writer set it and `false` if none
 * did, and neither value means anything: read `content_mode`.
 */
COMMENT ON COLUMN characters.nsfw_enabled IS
  'DEPRECATED (0036). content_mode is authoritative. Explicit roleplay is '
  'content_mode <> ''clean''; 18+ presentation and gating is content_mode = '
  '''adult_focused''. This column is retained only for compatibility with '
  'writers not yet migrated and is scheduled for removal.';

-- ---------------------------------------------------------------------------
-- Share-safe media, and the one safe line a gate may show
-- ---------------------------------------------------------------------------

ALTER TABLE characters ADD COLUMN IF NOT EXISTS share_image_path text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS share_image_url text NOT NULL DEFAULT '';

/*
 * Share media is a REVIEW STATE, not a creator's checkbox.
 *
 *   unreviewed  nominated by its creator, not yet classified. The default, and
 *               what every existing creation is: nothing in this database was
 *               published under a promise about link previews, so no image
 *               here is assumed to be one.
 *   safe        classified by the platform as suitable for an unrestricted
 *               external preview. The ONLY state that reaches an OG tag.
 *   adult       real media, correctly nominated, but not for an unrestricted
 *               preview. Usable inside the product, never outside it.
 *   rejected    refused. Not usable as a preview and flagged for its creator.
 *
 * A boolean would have made this a self-attestation, and self-attestation is
 * not a moderation policy: the creator with the strongest incentive to tick
 * "safe" on sexualised art is exactly the one the policy exists to stop. The
 * state therefore starts at `unreviewed` for everything, including clean
 * creations, and only Afterglow moves it to `safe`.
 *
 * The tempting backfill — `safe` wherever `nsfw_enabled` was false — is wrong
 * for the same reason. The old flag was about what the ROLEPLAY could do and
 * said nothing about the picture, so a creation that was never marked adult
 * can still have strongly sexualised cover art. Inferring consent from a flag
 * that answered a different question is how a product ends up putting
 * somebody's artwork somewhere they never agreed to.
 */
ALTER TABLE characters ADD COLUMN IF NOT EXISTS share_media_status text NOT NULL DEFAULT 'unreviewed';

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_share_media_status_allowed
    CHECK (share_media_status IN ('unreviewed','safe','adult','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN characters.share_media_status IS
  'Platform classification of this creation''s external preview media. Only '
  '''safe'' may leave Afterglow in an OG tag or link preview, and only '
  'Afterglow sets it — a creator nominates media, they do not classify it.';

/*
 * The safe line, kept apart from the page's own.
 *
 * A gate is read by people who do not yet know what they clicked, so it cannot
 * borrow the tagline: a tagline is written for a reader who has already chosen
 * the creation, and on an adult-focused page it is often the most explicit
 * sentence on it. This column is the creator's short line written FOR the
 * outside — a gate, a search snippet, a link preview — and an empty one means
 * the gate says something generic rather than something the creator did not
 * intend to publish there.
 */
ALTER TABLE characters ADD COLUMN IF NOT EXISTS share_tagline text NOT NULL DEFAULT '';

/*
 * The safe title, for the same reason as the safe line.
 *
 * A creation's `title` is written for its page and can be as explicit as its
 * subject; it is not a name that may appear in a search snippet, a browser tab
 * on somebody's work machine, or a Discord embed. `share_title` is the outward
 * name, and when it is empty the safe landing does not fall back to the real
 * title — it falls back to neutral copy naming only the creator. An empty
 * column costs a creation a good preview. Guessing costs somebody their job.
 */
ALTER TABLE characters ADD COLUMN IF NOT EXISTS share_title text NOT NULL DEFAULT '';

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_share_tagline_bounded
    CHECK (length(share_tagline) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_share_title_bounded
    CHECK (length(share_title) <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Worlds classify themselves
-- ---------------------------------------------------------------------------

/*
 * Nullable, and not backfilled from anything.
 *
 * A world is reusable independent content: the same setting can carry a clean
 * adventure and an explicit one, so neither the creations attached to it today
 * nor any flag it does not have can classify it. Inheriting the strictest
 * attached creation would also make a world's public standing change whenever
 * somebody else attaches something to it, which is not a property a creator
 * could reason about.
 *
 * NULL therefore means UNCLASSIFIED, and unclassified worlds stay out of the
 * anonymous path entirely — they are not published, not previewed and not
 * listed until their creator says what they are. Signed-in behaviour is
 * unchanged for every existing world.
 */
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS content_mode text;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS share_media_status text NOT NULL DEFAULT 'unreviewed';

DO $$ BEGIN
  ALTER TABLE worlds ADD CONSTRAINT worlds_content_mode_allowed
    CHECK (content_mode IS NULL OR content_mode IN ('clean','adult_capable','adult_focused'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE worlds ADD CONSTRAINT worlds_share_media_status_allowed
    CHECK (share_media_status IN ('unreviewed','safe','adult','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN worlds.content_mode IS
  'NULL means unclassified: the world has never been described by its creator '
  'and is excluded from every anonymous surface until it is.';

-- ---------------------------------------------------------------------------
-- The reader's side of the same question
-- ---------------------------------------------------------------------------

/*
 * Whether explicit content may be WRITTEN is not a property of the creation
 * alone, and this is where the other half lives.
 *
 * Afterglow has had an age gate since the beginning, but it was a line in the
 * browser's local storage: cleared with site data, absent on a second device,
 * and invisible to the server deciding what to put in a prompt. It could
 * therefore never be part of an access rule. These two columns are the durable
 * form of it.
 *
 *   `profiles.adult_confirmed_at` — the reader stated they are 18 or over.
 *     Identity-level, asked once, and what an adult-focused creation requires
 *     before it opens at all.
 *
 *   `user_settings.adult_content_enabled` — the reader wants explicit content.
 *     A preference, changeable, and separate on purpose: confirming your age
 *     is not the same as asking every story to become explicit, and an
 *     adult-capable creation is meant to stay clean for a reader who has not
 *     asked otherwise.
 *
 * The runtime rule that reads them both is `explicitRoleplayAllowed` in
 * src/lib/content-mode.ts, and it is the only place the three facts meet.
 */
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS adult_content_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The anonymous read path
-- ---------------------------------------------------------------------------

/*
 * These functions are the ONLY way an unauthenticated request reaches a row in
 * this database, and each one is written so the interesting property is
 * structural rather than remembered.
 *
 *   * `visibility = 'public'` — never unlisted. Unlisted means "reachable by
 *     people I gave the link to", and a crawler is not a person I gave the
 *     link to. Private and unlisted rows do not appear here at all.
 *
 *   * `moderation_status = 'active'` — a removed creation is not a public page.
 *
 *   * `SET search_path = public` on every one, so a SECURITY DEFINER body
 *     cannot be redirected by a caller's search path.
 *
 *   * No column that steers a model, and no column that belongs to an account:
 *     no personality, scenario, greeting, example dialogue, response
 *     directive, boundaries, lorebook, source material, cast definitions,
 *     conversations, memories, personas, moderation notes or e-mail. They are
 *     absent from the result types, not filtered out of them.
 */

/*
 * The safe landing model.
 *
 * The narrowest of the three, and the only one that answers for an
 * adult-focused creation. It is what a gate page and an external preview are
 * built from, so it carries the creation's identity, its creator, the line the
 * creator wrote for the outside, and media only if that media was nominated.
 *
 * Note what is NOT here, despite being public elsewhere: the tagline, the
 * description, the tags, the gallery and the statistics. On a clean creation
 * all of those are fine and `public_creation_card` returns them; on a gate
 * they would be the page leaking around its own gate one field at a time.
 */
DROP FUNCTION IF EXISTS public.public_creation_safe_landing(uuid);
CREATE FUNCTION public.public_creation_safe_landing(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, share_title text, share_tagline text,
  accent text, content_mode text,
  share_image_path text, share_image_url text, share_media_status text,
  avatar_path text, avatar_url text,
  creator_username text, creator_display_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.title, c.share_title, c.share_tagline, c.accent, c.content_mode,
         c.share_image_path, c.share_image_url, c.share_media_status,
         -- The avatar travels so a preview can fall back to a nominated cover,
         -- but only `share_media_status = 'safe'` lets any of it out; that is
         -- decided once, in `shareMedia`, rather than by each caller.
         c.avatar_path, c.avatar_url,
         COALESCE(p.username, ''), COALESCE(p.display_name, '')
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active';
$$;

/*
 * The card, for the modes that have a public identity beyond their gate.
 *
 * Everything the safe landing carries plus what a listing shows: the tagline,
 * the tags, the totals. Excluded for adult_focused by predicate rather than by
 * a flag the caller passes, so a caller that forgets the distinction gets no
 * row instead of a leak.
 */
DROP FUNCTION IF EXISTS public.public_creation_card(uuid);
CREATE FUNCTION public.public_creation_card(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  share_image_path text, share_image_url text, share_media_status text,
  avatar_path text, avatar_url text, tags text[], hashtags text[],
  message_count integer, chat_count integer, like_count integer,
  creator_username text, creator_display_name text,
  published_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.title, c.tagline, c.share_title, c.share_tagline,
         c.creation_type, c.profile_type, c.accent, c.content_mode,
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.avatar_path, c.avatar_url, c.tags, c.hashtags,
         c.message_count, c.chat_count, c.like_count,
         COALESCE(p.username, ''), COALESCE(p.display_name, ''),
         c.published_at, c.updated_at
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
     AND c.content_mode IN ('clean','adult_capable');
$$;

/*
 * The whole page.
 *
 * The overview is resolved in SQL rather than by shipping the columns it falls
 * back to. `creationOverview` in src/lib/creation.ts is the definition being
 * mirrored: the creator's description when there is one, and otherwise the
 * older fields the public page has always fallen back to, so a creation
 * written before descriptions existed still reads as a page. Doing it here is
 * the narrower contract — an anonymous caller gets the one derived string
 * instead of the raw fields plus a promise about which of them a client will
 * render.
 */
DROP FUNCTION IF EXISTS public.public_creation_page(uuid);
CREATE FUNCTION public.public_creation_page(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  user_role text, overview text, description_rich jsonb,
  quick_facts jsonb, tags text[], hashtags text[],
  avatar_path text, avatar_url text,
  share_image_path text, share_image_url text, share_media_status text,
  message_count integer, chat_count integer, like_count integer,
  creator_username text, creator_display_name text, creator_avatar_path text,
  creator_border text, creator_follower_count integer,
  published_at timestamptz, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.title, c.tagline, c.share_title, c.share_tagline,
         c.creation_type, c.profile_type, c.accent, c.content_mode, c.user_role,
         COALESCE(
           NULLIF(BTRIM(COALESCE(c.description, '')), ''),
           NULLIF(BTRIM(CASE
             WHEN COALESCE(NULLIF(c.creation_type, ''), CASE WHEN c.profile_type = 'ensemble' THEN 'cast' ELSE 'character' END) = 'scenario'
               THEN CONCAT_WS(E'\n\n', NULLIF(BTRIM(COALESCE(c.scenario, '')), ''), NULLIF(BTRIM(COALESCE(c.backstory, '')), ''))
             ELSE CONCAT_WS(E'\n\n', NULLIF(BTRIM(COALESCE(c.backstory, '')), ''), NULLIF(BTRIM(COALESCE(c.personality, '')), ''))
           END), ''),
           ''
         ),
         c.description_rich,
         c.quick_facts, c.tags, c.hashtags,
         c.avatar_path, c.avatar_url,
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.message_count, c.chat_count, c.like_count,
         COALESCE(p.username, ''), COALESCE(p.display_name, ''), COALESCE(p.avatar_path, ''),
         COALESCE(p.profile_border, 'default'), COALESCE(p.follower_count, 0),
         c.published_at, c.created_at, c.updated_at
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
     AND c.content_mode IN ('clean','adult_capable');
$$;

/*
 * The gallery of such a creation.
 *
 * Separate from the page so the media rule stays visible on its own: a gallery
 * is INSIDE the page, behind the same predicate, and is never the source of a
 * link preview. Neither the card nor the safe landing has a gallery column.
 */
DROP FUNCTION IF EXISTS public.public_creation_gallery(uuid);
CREATE FUNCTION public.public_creation_gallery(p_id uuid)
RETURNS TABLE (id uuid, storage_path text, external_url text, caption text, position integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id, g.storage_path, g.external_url, g.caption, g.position
    FROM character_gallery g
   WHERE g.character_id = p_id
     AND EXISTS (
       SELECT 1 FROM characters c
        WHERE c.id = p_id
          AND c.visibility = 'public'
          AND c.moderation_status = 'active'
          AND c.content_mode IN ('clean','adult_capable')
     )
   ORDER BY g.position ASC, g.created_at ASC;
$$;

/*
 * Cast members, as the public page shows them.
 *
 * `tagline` is the short line the creator wrote for readers; `description` is
 * the member's AI definition and is not in this result type. Same rule as the
 * rest of the file: the private half is absent rather than filtered.
 */
DROP FUNCTION IF EXISTS public.public_creation_cast(uuid);
CREATE FUNCTION public.public_creation_cast(p_id uuid)
RETURNS TABLE (member jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'key', m.value->>'key',
           'name', m.value->>'name',
           'role', COALESCE(m.value->>'role', ''),
           'blurb', COALESCE(m.value->>'tagline', ''),
           'avatarPath', COALESCE(m.value->>'avatarPath', ''),
           'avatarUrl', COALESCE(m.value->>'avatarUrl', '')
         )
    FROM characters c
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.cast_members) = 'array' THEN c.cast_members ELSE '[]'::jsonb END
    ) AS m(value)
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
     AND c.content_mode IN ('clean','adult_capable')
     AND COALESCE(BTRIM(m.value->>'name'), '') <> '';
$$;

/*
 * A public world, without its lore, and only once classified.
 *
 * The lore IS the world, so this is not a partial page — it is the card that
 * stands where the page would be. Reading lore is a signed-in act, exactly as
 * reading a creation's greeting always was.
 */
DROP FUNCTION IF EXISTS public.public_world_card(uuid);
CREATE FUNCTION public.public_world_card(p_id uuid)
RETURNS TABLE (
  id uuid, name text, description text, content_mode text,
  cover_path text, cover_url text, share_media_status text,
  save_count integer, creator_username text, creator_display_name text,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id, w.name, w.description, w.content_mode,
         w.cover_path, w.cover_url, w.share_media_status,
         COALESCE(w.save_count, 0),
         COALESCE(p.username, ''), COALESCE(p.display_name, ''),
         w.created_at, w.updated_at
    FROM worlds w
    LEFT JOIN profiles p ON p.id = w.user_id AND p.username IS NOT NULL
   WHERE w.id = p_id
     AND w.visibility = 'public'
     AND w.content_mode IS NOT NULL
     AND w.content_mode <> 'adult_focused';
$$;

DROP FUNCTION IF EXISTS public.public_creator_profile(text);
CREATE FUNCTION public.public_creator_profile(p_username text)
RETURNS TABLE (
  username text, display_name text, bio text, avatar_path text, cover_path text,
  profile_border text, follower_count integer, following_count integer,
  published_creations integer, published_worlds integer, rank integer, created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.username, COALESCE(p.display_name, ''), COALESCE(p.bio, ''),
         COALESCE(p.avatar_path, ''), COALESCE(p.cover_path, ''),
         COALESCE(p.profile_border, 'default'),
         COALESCE(p.follower_count, 0), COALESCE(p.following_count, 0),
         COALESCE(cs.published_creations, 0), COALESCE(cs.published_worlds, 0),
         cs.rank, p.created_at
    FROM profiles p
    LEFT JOIN creator_stats cs ON cs.user_id = p.id
   WHERE p.username IS NOT NULL
     AND lower(p.username) = lower(p_username);
$$;

/*
 * A creator's shelf.
 *
 * Adult-focused creations are listed — a creator's body of work is
 * misdescribed by hiding part of it — but each row carries only what its own
 * gate would show. The CASE expressions are why: the tagline, the tags and the
 * totals of an adult-focused creation are blanked in the result, so this
 * function cannot become the way around `public_creation_card`'s predicate.
 */
DROP FUNCTION IF EXISTS public.public_creator_creations(text, integer, integer);
CREATE FUNCTION public.public_creator_creations(p_username text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  avatar_path text, avatar_url text,
  share_image_path text, share_image_url text, share_media_status text,
  tags text[], hashtags text[],
  message_count integer, chat_count integer, like_count integer, published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name,
         -- The real title is blanked for a gated row exactly as the tagline is:
         -- it is page copy, and `share_title` is the outward name.
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.title END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.tagline END,
         c.share_title, c.share_tagline,
         c.creation_type, c.profile_type, c.accent, c.content_mode,
         c.avatar_path, c.avatar_url,
         c.share_image_path, c.share_image_url, c.share_media_status,
         CASE WHEN c.content_mode = 'adult_focused' THEN ARRAY[]::text[] ELSE c.tags END,
         CASE WHEN c.content_mode = 'adult_focused' THEN ARRAY[]::text[] ELSE c.hashtags END,
         CASE WHEN c.content_mode = 'adult_focused' THEN 0 ELSE c.message_count END,
         CASE WHEN c.content_mode = 'adult_focused' THEN 0 ELSE c.chat_count END,
         CASE WHEN c.content_mode = 'adult_focused' THEN 0 ELSE c.like_count END,
         c.published_at
    FROM characters c
    JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE lower(p.username) = lower(p_username)
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
   ORDER BY c.published_at DESC NULLS LAST, c.created_at DESC
   LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 24), 100))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

/*
 * What a sitemap may list.
 *
 * Adult-focused creations are excluded, and so is every unclassified world. A
 * gate page is a real page and may be linked, but a sitemap is an invitation
 * to index a catalogue, and the catalogue being offered here is the one that
 * can be read without an account.
 */
DROP FUNCTION IF EXISTS public.public_sitemap_entries(integer);
CREATE FUNCTION public.public_sitemap_entries(p_limit integer)
RETURNS TABLE (kind text, slug text, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  (
    SELECT 'creation', c.id::text, GREATEST(c.updated_at, COALESCE(c.published_at, c.updated_at))
      FROM characters c
     WHERE c.visibility = 'public'
       AND c.moderation_status = 'active'
       AND c.content_mode IN ('clean','adult_capable')
     ORDER BY c.updated_at DESC
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 5000), 20000))
  )
  UNION ALL
  (
    SELECT 'world', w.id::text, w.updated_at
      FROM worlds w
     WHERE w.visibility = 'public'
       AND w.content_mode IS NOT NULL
       AND w.content_mode <> 'adult_focused'
     ORDER BY w.updated_at DESC
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 5000), 20000))
  )
  UNION ALL
  (
    SELECT 'creator', p.username, GREATEST(p.created_at, COALESCE(p.updated_at, p.created_at))
      FROM profiles p
     WHERE p.username IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM characters c
          WHERE c.user_id = p.id
            AND c.visibility = 'public'
            AND c.moderation_status = 'active'
            AND c.content_mode IN ('clean','adult_capable')
       )
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 5000), 20000))
  );
$$;

/*
 * Granted to `anon` as well as `authenticated`, which is the entire point of
 * the file — and revoked from PUBLIC first, so the grant is a list rather than
 * a default. `anon` receives no table privileges anywhere in this schema;
 * these nine result types are the whole of what an unauthenticated request can
 * see.
 */
REVOKE ALL ON FUNCTION public.public_creation_safe_landing(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creation_card(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creation_page(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creation_gallery(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creation_cast(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_world_card(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creator_profile(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creator_creations(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_sitemap_entries(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.public_creation_safe_landing(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creation_card(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creation_page(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creation_gallery(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creation_cast(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_world_card(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creator_profile(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creator_creations(text, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_sitemap_entries(integer) TO anon, authenticated;

CREATE INDEX IF NOT EXISTS characters_public_mode_idx
  ON characters (content_mode, updated_at DESC)
  WHERE visibility = 'public' AND moderation_status = 'active';
