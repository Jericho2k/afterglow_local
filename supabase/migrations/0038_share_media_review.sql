-- Getting a creation's own artwork into its link preview, safely.
--
-- 0036 split classification from nomination: a creator NOMINATES an image for
-- sharing (`share_image_path`, `share_image_url`, or their cover by default)
-- and the platform CLASSIFIES it (`share_media_status`), and only `safe` may
-- leave Afterglow. The half that shipped was the refusal. Nothing ever wrote
-- `safe`, so in practice every external preview in the product was the same
-- picture, and the classification column was a permanently closed door.
--
-- This migration is the small database half of opening it. There is no
-- automated image classifier in this deployment — see
-- docs/share-media-review-2026-09.md, which says so plainly rather than
-- inventing a dependency — so the reviewer is the moderator who already exists,
-- and the audit trail is the one that already exists.
--
--   * The safe landing gains the creation's STRUCTURE, so a preview card can
--     say Character, Cast or Scenario. It is platform vocabulary rather than
--     anything the creator wrote, which is why it is safe for a gated creation
--     whose name and title this function deliberately blanks.
--
--   * `moderation_actions` gains one more permitted action, so classifying an
--     image is recorded in the same immutable log as removing a creation.
--     Nothing else about that table changes: it is still insert-only, still
--     unreadable to `anon` and `authenticated`, and still keyed by creation.
--
-- What this migration deliberately does NOT do is give anybody a way to write
-- `share_media_status` from a creation payload. The column stays absent from
-- `characterSchema`, and the application resets it to `unreviewed` whenever the
-- nominated image changes — so approving an image approves THAT image, and
-- swapping in another one starts again.

-- ---------------------------------------------------------------------------
-- The safe landing, which is also what an external preview is drawn from
-- ---------------------------------------------------------------------------

/*
 * Recreated rather than altered: a function's result type is part of its
 * signature, so adding a column means dropping and defining it again. The body
 * is otherwise unchanged from 0036, including the blanking of `name` and
 * `title` for a gated creation — repeated here because that rule is the whole
 * point of this function and must not be lost in a refactor.
 */
DROP FUNCTION IF EXISTS public.public_creation_safe_landing(uuid);
CREATE FUNCTION public.public_creation_safe_landing(p_id uuid)
RETURNS TABLE (
  id uuid, name text, title text, share_title text, share_tagline text,
  accent text, content_mode text,
  creation_type text, profile_type text,
  share_image_path text, share_image_url text, share_media_status text,
  avatar_path text, avatar_url text,
  creator_username text, creator_display_name text
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
         /*
          * Structure, which every mode may state.
          *
          * "Character", "Cast" or "Scenario" is the platform's own vocabulary
          * for the shape of a creation. It describes what a reader would be
          * opening, not what is in it, so it is as safe on a gated creation's
          * preview as the 18+ marker beside it — and without it two very
          * different things share one anonymous card.
          */
         c.creation_type, c.profile_type,
         -- The avatar travels so a preview can fall back to a nominated cover,
         -- but only `share_media_status = 'safe'` lets any of it out; that is
         -- decided once, in `shareMedia`, rather than by each caller.
         c.share_image_path, c.share_image_url, c.share_media_status,
         c.avatar_path, c.avatar_url,
         COALESCE(p.username, ''), COALESCE(p.display_name, '')
    FROM characters c
    LEFT JOIN profiles p ON p.id = c.user_id AND p.username IS NOT NULL
   WHERE c.id = p_id
     AND c.visibility = 'public'
     AND c.moderation_status = 'active';
$$;

REVOKE ALL ON FUNCTION public.public_creation_safe_landing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_creation_safe_landing(uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Classification, in the log that already records moderation
-- ---------------------------------------------------------------------------

/*
 * One new action, with the outcome in `metadata`.
 *
 * Not three actions. "Approved this image", "marked it adult" and "rejected it"
 * are one decision with three answers, and putting the answer in the metadata
 * keeps a later fourth answer from being another constraint migration.
 */
ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_allowed;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_allowed CHECK
  (action IN ('mark_reviewing','dismiss','resolve_no_removal','remove_creation','restore_creation','classify_share_media'));

/*
 * The review queue's index.
 *
 * The queue asks one question — which published creations have media nobody
 * has classified — and it is asked by a moderator, rarely, over a table that
 * every reader's page also uses. A partial index keeps it off the hot path and
 * costs nothing on the rows it excludes.
 */
CREATE INDEX IF NOT EXISTS characters_share_media_review_idx
  ON characters (share_media_status, updated_at DESC)
  WHERE visibility = 'public';
