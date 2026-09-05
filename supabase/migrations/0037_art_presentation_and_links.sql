-- Creator control over how artwork is presented, and links on a profile.
--
-- A creator uploads one image and the product shows it in six places at four
-- different shapes: a 3:4 discovery card, a ranked row's small square, a
-- full-bleed hero on a phone, a wide band on a desktop. Until now every one of
-- those crops was decided by a hardcoded `object-position` in a stylesheet —
-- `50% 25%` on cards, `50% 22%` then `30% 26%` on the hero — chosen once,
-- for no particular image, and applied to all of them. Artwork whose subject
-- is not near that point gets beheaded on the card or centred on somebody's
-- elbow in the hero, and the creator's only recourse is to re-crop the file
-- offline and upload a version that looks wrong somewhere else instead.
--
-- So the crop becomes DATA rather than a constant, and the data is stored
-- beside the image instead of baked into it.
--
--   * The original asset is never touched. Nothing here rewrites, re-encodes
--     or replaces an upload; `art_presentation` says how to FRAME the image
--     that already exists, and deleting the metadata restores exactly today's
--     behaviour.
--
--   * It is a document, not two float columns. A focal point is the first
--     thing a creator needs and not the last: per-aspect overrides, a zoom, a
--     safe-area rectangle are all the same kind of fact, and each would be
--     another migration if the shape were fixed columns. The document is
--     versioned so a reader can tell what it is looking at.
--
--   * An empty document means "no metadata", which is what every existing
--     creation has, and every surface then keeps the CSS default it has today.
--     This migration therefore changes the appearance of nothing.
--
-- The banner is a separate ASSET rather than part of that document, because
-- that is what it is: a second image, and every other image in this schema is
-- a `_path` plus a `_url` pair (avatar, share image, world cover). It is
-- optional, and a creation without one falls back to its primary artwork
-- framed by the same focal point.

-- ---------------------------------------------------------------------------
-- Presentation metadata
-- ---------------------------------------------------------------------------

ALTER TABLE characters ADD COLUMN IF NOT EXISTS art_presentation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS banner_path text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS banner_url text NOT NULL DEFAULT '';

/*
 * The document's shape, as far as the database cares.
 *
 * Deliberately shallow: an object, with focal coordinates that are numbers
 * between 0 and 1 when they are present at all. The application validates the
 * rest — see `src/lib/art-presentation.ts`, which is the single reader — but
 * the two things a bad write could do that no reader can undo are storing a
 * non-object and storing coordinates that are not coordinates, and those are
 * refused here.
 *
 * `jsonb_typeof(... -> 'focal' ->> 'x')` is not used because a JSON number
 * survives as a number: the check reads the value and compares it, so a string
 * "0.5" fails rather than silently becoming a position.
 */
DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_art_presentation_shape CHECK (
    jsonb_typeof(art_presentation) = 'object'
    AND (
      art_presentation -> 'cover' -> 'focal' IS NULL
      OR (
        jsonb_typeof(art_presentation -> 'cover' -> 'focal' -> 'x') = 'number'
        AND jsonb_typeof(art_presentation -> 'cover' -> 'focal' -> 'y') = 'number'
        AND (art_presentation -> 'cover' -> 'focal' ->> 'x')::numeric BETWEEN 0 AND 1
        AND (art_presentation -> 'cover' -> 'focal' ->> 'y')::numeric BETWEEN 0 AND 1
      )
    )
    AND (
      art_presentation -> 'banner' -> 'focal' IS NULL
      OR (
        jsonb_typeof(art_presentation -> 'banner' -> 'focal' -> 'x') = 'number'
        AND jsonb_typeof(art_presentation -> 'banner' -> 'focal' -> 'y') = 'number'
        AND (art_presentation -> 'banner' -> 'focal' ->> 'x')::numeric BETWEEN 0 AND 1
        AND (art_presentation -> 'banner' -> 'focal' ->> 'y')::numeric BETWEEN 0 AND 1
      )
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/*
 * A banner is NOT share media.
 *
 * It is the widest, most prominent image a creation has, which makes it the
 * most tempting thing to put in a link preview and the one most likely to be
 * chosen for impact rather than for suitability outside Afterglow. Nominating
 * share media stays its own act with its own review, so this comment stands in
 * for the code that would otherwise, one day, "helpfully" fall back to it.
 */

-- ---------------------------------------------------------------------------
-- Creator links
-- ---------------------------------------------------------------------------

/*
 * A small, bounded set of links on a public profile.
 *
 * Creators arrive with an audience somewhere else, and a profile that cannot
 * point at it makes them choose between the two. The bound matters more than
 * the feature: an unbounded list on a public page is a link farm with extra
 * steps, so the count is capped in the database rather than in whichever form
 * happens to be submitting.
 *
 * Protocol validation lives in `src/lib/creator-links.ts` and is enforced on
 * write; only http and https are ever stored, which is what keeps a
 * `javascript:` URL from reaching an anchor on a page anybody can open.
 */
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_links_bounded CHECK (
    jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 6
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- The anonymous path sees the same presentation
-- ---------------------------------------------------------------------------

/*
 * Every public function that carries artwork now carries how to frame it.
 *
 * This is the whole reason these are being replaced: a public page that reads
 * the same image with a different crop than the signed-in page is a different
 * page, and the creator only got to make the decision once. `banner_*` and
 * `art_presentation` therefore travel with `avatar_*` everywhere it goes.
 *
 * `public_creation_safe_landing` is the exception and keeps neither. A gate
 * shows nominated share media or a branded card, never the creation's own
 * artwork, so framing information for an image it will not display would be
 * the only field in that result type with nothing to render it.
 */

DROP FUNCTION IF EXISTS public.public_creation_page(uuid);
CREATE FUNCTION public.public_creation_page(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  user_role text, overview text, description_rich jsonb,
  quick_facts jsonb, tags text[], hashtags text[],
  avatar_path text, avatar_url text,
  banner_path text, banner_url text, art_presentation jsonb,
  share_image_path text, share_image_url text, share_media_status text,
  message_count integer, chat_count integer, like_count integer,
  creator_username text, creator_display_name text, creator_avatar_path text,
  creator_border text, creator_follower_count integer, creator_links jsonb,
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
         c.banner_path, c.banner_url, c.art_presentation,
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.message_count, c.chat_count, c.like_count,
         COALESCE(p.username, ''), COALESCE(p.display_name, ''), COALESCE(p.avatar_path, ''),
         COALESCE(p.profile_border, 'default'), COALESCE(p.follower_count, 0),
         COALESCE(p.links, '[]'::jsonb),
         c.published_at, c.created_at, c.updated_at
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
     AND c.content_mode IN ('clean','adult_capable');
$$;

DROP FUNCTION IF EXISTS public.public_creation_card(uuid);
CREATE FUNCTION public.public_creation_card(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  share_image_path text, share_image_url text, share_media_status text,
  avatar_path text, avatar_url text,
  banner_path text, banner_url text, art_presentation jsonb,
  tags text[], hashtags text[],
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
         c.avatar_path, c.avatar_url,
         c.banner_path, c.banner_url, c.art_presentation,
         c.tags, c.hashtags,
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

DROP FUNCTION IF EXISTS public.public_creator_creations(text, integer, integer);
CREATE FUNCTION public.public_creator_creations(p_username text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid, name text, title text, tagline text, share_title text, share_tagline text,
  creation_type text, profile_type text, accent text, content_mode text,
  avatar_path text, avatar_url text,
  banner_path text, banner_url text, art_presentation jsonb,
  share_image_path text, share_image_url text, share_media_status text,
  tags text[], hashtags text[],
  message_count integer, chat_count integer, like_count integer, published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id,
         -- Name and title are blanked for a gated row exactly as the tagline
         -- is: they are page copy, and `share_title` is the outward name. See
         -- `public_creation_safe_landing` in 0036 for why these are absent
         -- from the result rather than ignored by the caller.
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.name END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.title END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.tagline END,
         c.share_title, c.share_tagline,
         c.creation_type, c.profile_type, c.accent, c.content_mode,
         -- A gated row's own artwork is not sent either: the shelf draws it
         -- from nominated share media, and an unnominated one gets the card.
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.avatar_path END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.avatar_url END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.banner_path END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.banner_url END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '{}'::jsonb ELSE c.art_presentation END,
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.tags, c.hashtags,
         c.message_count, c.chat_count, c.like_count, c.published_at
    FROM characters c
    JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE lower(p.username) = lower(p_username)
     AND c.visibility = 'public'
     AND c.moderation_status = 'active'
   ORDER BY c.published_at DESC NULLS LAST, c.created_at DESC
   LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 24), 100))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

DROP FUNCTION IF EXISTS public.public_creator_profile(text);
CREATE FUNCTION public.public_creator_profile(p_username text)
RETURNS TABLE (
  username text, display_name text, bio text, avatar_path text, cover_path text,
  profile_border text, follower_count integer, following_count integer,
  published_creations integer, published_worlds integer, rank integer,
  links jsonb, created_at timestamptz
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
         cs.rank, COALESCE(p.links, '[]'::jsonb), p.created_at
    FROM profiles p
    LEFT JOIN creator_stats cs ON cs.user_id = p.id
   WHERE p.username IS NOT NULL
     AND lower(p.username) = lower(p_username);
$$;

REVOKE ALL ON FUNCTION public.public_creation_page(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creation_card(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creator_creations(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_creator_profile(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.public_creation_page(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creation_card(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creator_creations(text, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_creator_profile(text) TO anon, authenticated;
