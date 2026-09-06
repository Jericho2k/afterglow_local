-- Letting an ordinary creation's own artwork into its link preview, and giving
-- the card a creator rather than an initial.
--
-- 0038 opened the classification door and nobody has walked through it. Every
-- creation is born `share_media_status = 'unreviewed'`, nothing in this
-- deployment classifies automatically, and a moderator can only work through a
-- queue — so in practice the composed card that shipped renders the artless
-- fallback for the entire public catalogue. The card is a good card. It is
-- also, today, the same card for a clean scenario and a clean cast.
--
-- The rule that produced that is right for one mode and wrong for the other
-- two. `shareMedia` asks "may this leave Afterglow", and answers no for
-- anything unclassified. For an adult-focused creation — whose page a stranger
-- may not read at all — that is exactly the correct caution. For a clean or
-- adult-capable one it protects nothing: the artwork is already on a page that
-- anonymous visitors and search engines read, one click behind the very link
-- the card is previewing. Withholding it there does not keep an image private,
-- it just makes the preview useless.
--
-- So this migration widens the safe landing for the OPEN modes only, and does
-- it structurally rather than by asking the application to remember:
--
--   * Four new columns carry the creation's own nominated artwork, and each is
--     blanked by a CASE for `adult_focused`. An adult-focused row cannot
--     express its cover through them — not "must not", cannot — which is the
--     same technique `public_creator_creations` already uses for its shelf.
--
--   * `share_image_path`, `share_image_url`, `avatar_path` and `avatar_url`
--     are UNCHANGED and still travel for every mode. They are the classified
--     path: `shareMedia` releases them only at `share_media_status = 'safe'`,
--     which is how an adult-focused creation can still have a preview image
--     when a moderator has approved that exact image. Two sets of columns
--     because there are two questions, and the answer to one of them must stay
--     "no" for a gated creation whatever happens to the other.
--
--   * `art_presentation` travels for the open modes, so the card crops toward
--     the point the creator chose instead of a constant chosen for no
--     particular image. Blanked for a gated creation, which has no artwork
--     here to frame.
--
--   * `creator_avatar_path` is the creator's PUBLIC profile picture — the same
--     one their profile page and every creation page already show — and it
--     replaces the boxed initial the fallback card used to draw. An initial of
--     a title says nothing; a face says who made this. It travels for every
--     mode, including the gated one, because it identifies the creator rather
--     than the creation, and the join it comes from already requires a public
--     handle.
--
-- Nothing else about the function changes. The blanking of `name` and `title`
-- for an adult-focused creation is repeated verbatim below, as it was in 0038,
-- because it is the whole point of this function and must survive every
-- redefinition of it.
--
-- This migration adds no image moderation. `share_media_status` still means
-- exactly what it meant, `adult` and `rejected` still withhold an image in
-- every mode, and the only status whose treatment changes is `unreviewed`, and
-- only for creations whose page is already public.

DROP FUNCTION IF EXISTS public.public_creation_safe_landing(uuid);
CREATE FUNCTION public.public_creation_safe_landing(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, share_title text, share_tagline text,
  accent text, content_mode text,
  creation_type text, profile_type text,
  share_image_path text, share_image_url text, share_media_status text,
  avatar_path text, avatar_url text,
  open_share_image_path text, open_share_image_url text,
  open_avatar_path text, open_avatar_url text,
  art_presentation jsonb,
  creator_username text, creator_display_name text, creator_avatar_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id,
         -- The internal name and the page title are BLANKED for a gated
         -- creation rather than merely ignored by the caller that renders it.
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.name END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.title END,
         c.share_title, c.share_tagline, c.accent, c.content_mode,
         -- Structure, which every mode may state: it describes what a reader
         -- would be opening rather than what is inside it.
         c.creation_type, c.profile_type,
         /*
          * The CLASSIFIED path, unchanged since 0036.
          *
          * These travel for every mode and are released by `shareMedia` only
          * at `share_media_status = 'safe'`. This is the only way an
          * adult-focused creation's image reaches an external card, and it
          * requires a moderator to have looked at that exact file.
          */
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.avatar_path, c.avatar_url,
         /*
          * The OPEN path, new here.
          *
          * The same artwork, blanked for a gated creation. What these express
          * is not "may this leave Afterglow" but "is this already on a page
          * anonymous readers may open" — and for a clean or adult-capable
          * creation the answer is yes, which is why a card built from them
          * needs no classification. An adult-focused row carries empty strings
          * in all four, so the widening cannot reach it even by mistake.
          */
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.share_image_path END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.share_image_url END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.avatar_path END,
         CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.avatar_url END,
         -- How the creator asked their artwork to be framed, so an external
         -- crop lands where they said the subject is.
         CASE WHEN c.content_mode = 'adult_focused' THEN '{}'::jsonb ELSE c.art_presentation END,
         COALESCE(p.username, ''), COALESCE(p.display_name, ''),
         -- Public identity, for every mode. The creator of a gated creation is
         -- not gated; their profile page is already open and already shows
         -- this picture.
         COALESCE(p.avatar_path, '')
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active';
$$;

REVOKE ALL ON FUNCTION public.public_creation_safe_landing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_creation_safe_landing(uuid) TO anon, authenticated;
