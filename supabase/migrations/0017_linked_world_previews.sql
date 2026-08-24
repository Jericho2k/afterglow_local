-- Locked world previews on a public creation.
--
-- A public creation may be built on a private world, and the creation page is
-- already written to show that: the API returns a `locked` stand-in carrying a
-- name and a cover and nothing else, and the card renders it unopenable. None
-- of that could ever run, because `worlds_select_own_or_published` hides the
-- row itself — the join returned nothing, the association silently vanished,
-- and the branch that handles it was unreachable code.
--
-- Loosening that policy is the wrong fix. It would make the whole row readable
-- and leave "no lore escapes" as a property of every SELECT anyone ever writes
-- against `worlds` again. So the preview is a function instead, and the
-- function is the entire contract:
--
--   * It returns FOUR COLUMNS. Not a filtered row, not a row with columns
--     blanked afterwards — the lore, the description, the creator, the
--     timestamps and the save counts are not in the result type at all, so no
--     caller can select them by accident and no future edit can widen this by
--     forgetting a CASE.
--
--   * It is SECURITY DEFINER, so it sees past the policy, and it re-checks
--     authorisation itself: the caller must be able to read the CREATION that
--     links the world. A private world attached to a private creation belongs
--     to nobody else's page and is not previewed.
--
--   * It reads `auth.uid()` rather than taking a viewer argument, so it cannot
--     be called on somebody else's behalf.
--
-- Additive and backward compatible: no table, column, policy or row changes,
-- and the existing readable-world query is untouched.

CREATE OR REPLACE FUNCTION public.creation_world_previews(p_character_id uuid)
RETURNS TABLE (id uuid, name text, cover_path text, cover_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id, w.name, w.cover_path, w.cover_url
  FROM character_worlds cw
  JOIN worlds w ON w.id = cw.world_id
  WHERE cw.character_id = p_character_id
    AND EXISTS (
      SELECT 1 FROM characters c
      WHERE c.id = p_character_id
        AND (c.user_id = auth.uid() OR c.visibility IN ('public', 'unlisted'))
    )
  ORDER BY w.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.creation_world_previews(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_world_previews(uuid) TO authenticated;
