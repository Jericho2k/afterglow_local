-- Every profile is public.
--
-- 0022 made PUBLISHING the opt-in to being named, replacing "choosing a
-- username is the opt-in". That was the right direction and it did not go far
-- enough: it still left two classes of account, one with a page and one
-- without, and every policy in the social layer had to ask which kind it was
-- looking at.
--
-- There is no such thing as a non-public profile. Everybody has a page. Whether
-- somebody has put a picture, a name and a bio on theirs is their business, and
-- an empty page is not a private one — it is a page nobody has decorated. That
-- is one rule instead of two, and it removes a whole category of "why can I see
-- this creator here but not there" from the product.
--
-- Concretely this migration:
--
--   1. gives every account a handle, at signup and by backfill, so every
--      profile is ADDRESSABLE rather than merely readable;
--   2. drops the `username IS NOT NULL` gate from every policy that carried it;
--   3. drops it from the ranking rebuild, where it is now vacuous.
--
-- Additive and idempotent. Nothing is deleted, no column changes meaning, and
-- re-running the file is a no-op.

-- ---------------------------------------------------------------------------
-- A handle for every account
-- ---------------------------------------------------------------------------
--
-- `ensure_public_username` (0022) already knows how to derive one safely — in
-- particular that it must never build a handle, or leave a display name, out of
-- the local part of an email address, which is what `handle_new_user` falls
-- back to when somebody signs up without typing a name. It is now called at
-- signup rather than only at first publish.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''), split_part(NEW.email, '@', 1), 'Traveller')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Every account has a page from the moment it exists. The function is a
  -- no-op when a handle is already set, so this is safe on any replay.
  PERFORM public.ensure_public_username(NEW.id);

  RETURN NEW;
END;
$$;

-- Everybody who signed up before this migration.
DO $$
DECLARE
  account uuid;
BEGIN
  FOR account IN SELECT id FROM profiles WHERE username IS NULL LOOP
    PERFORM public.ensure_public_username(account);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The policies that used to ask
-- ---------------------------------------------------------------------------

/*
 * A profile is readable by any signed-in account.
 *
 * What leaves the server is still decided above this line — `publicProfile()`
 * in src/app/api/profile/route.ts picks the fields a page may show, and the
 * subscription tier is not among them. Row level security answers "which rows",
 * and the answer is now simply "all of them", because there is no such thing as
 * a profile that is not public.
 */
DROP POLICY IF EXISTS profiles_select_own ON profiles;
DROP POLICY IF EXISTS profiles_select_own_or_public ON profiles;
DROP POLICY IF EXISTS profiles_select_all ON profiles;
CREATE POLICY profiles_select_all ON profiles
  FOR SELECT TO authenticated USING (true);

/*
 * Anybody may be followed.
 *
 * The refusals that matter are unchanged and still live here rather than in
 * whichever route writes the row: you may only ever create your own follow, and
 * you may not follow yourself (a CHECK constraint). What is gone is the third
 * one — that the target had opted into a public profile — because there is no
 * longer anything to opt into.
 */
DROP POLICY IF EXISTS profile_follows_insert_own ON profile_follows;
CREATE POLICY profile_follows_insert_own ON profile_follows
  FOR INSERT TO authenticated
  WITH CHECK (
    follower_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = creator_user_id)
  );

-- Achievements and history are public-safe facts about public work, and they
-- belong to a page everybody has. Writing is unchanged: self only, which is
-- what makes an unlock impossible to grant to somebody else.
DROP POLICY IF EXISTS profile_achievements_select ON profile_achievements;
CREATE POLICY profile_achievements_select ON profile_achievements
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS profile_activity_select ON profile_activity;
CREATE POLICY profile_activity_select ON profile_activity
  FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Standing
-- ---------------------------------------------------------------------------
--
-- Unchanged except that the handle is no longer asked about. A creator is
-- ranked once they have published something public — ranking an account that
-- has published nothing would put tens of thousands of accounts in a tie at the
-- bottom and make the number meaningless for the ones who have.

CREATE OR REPLACE FUNCTION public.refresh_creator_stats()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ranked integer;
BEGIN
  WITH totals AS (
    SELECT p.id AS user_id,
           COALESCE(c.creations, 0) AS published_creations,
           COALESCE(w.worlds, 0) AS published_worlds,
           COALESCE(c.messages, 0) AS user_messages,
           COALESCE(c.saves, 0) AS saves,
           COALESCE(p.follower_count, 0) AS followers
    FROM profiles p
    LEFT JOIN (
      SELECT user_id, count(*) AS creations,
             sum(user_message_count)::bigint AS messages,
             sum(like_count)::bigint AS saves
      FROM characters WHERE visibility = 'public' GROUP BY user_id
    ) c ON c.user_id = p.id
    LEFT JOIN (
      SELECT user_id, count(*) AS worlds FROM worlds WHERE visibility = 'public' GROUP BY user_id
    ) w ON w.user_id = p.id
    WHERE COALESCE(c.creations, 0) > 0
  ), placed AS (
    SELECT totals.*,
           rank() OVER (
             ORDER BY user_messages DESC, followers DESC, saves DESC, published_creations DESC, user_id
           ) AS rank,
           count(*) OVER () AS rank_total
    FROM totals
  )
  INSERT INTO creator_stats (user_id, published_creations, published_worlds, user_messages, saves, followers, rank, rank_total, computed_at)
  SELECT user_id, published_creations, published_worlds, user_messages, saves, followers, rank, rank_total, now() FROM placed
  ON CONFLICT (user_id) DO UPDATE SET
    published_creations = EXCLUDED.published_creations,
    published_worlds = EXCLUDED.published_worlds,
    user_messages = EXCLUDED.user_messages,
    saves = EXCLUDED.saves,
    followers = EXCLUDED.followers,
    rank = EXCLUDED.rank,
    rank_total = EXCLUDED.rank_total,
    computed_at = now();

  GET DIAGNOSTICS ranked = ROW_COUNT;

  -- A creator who unpublished everything stops being ranked rather than
  -- keeping the standing they had when they last published.
  DELETE FROM creator_stats s
  WHERE NOT EXISTS (
    SELECT 1 FROM characters c
    WHERE c.user_id = s.user_id AND c.visibility = 'public'
  );

  UPDATE creator_stats_refresh SET refreshed_at = now() WHERE id = true;
  RETURN ranked;
END;
$$;

SELECT public.refresh_creator_stats();
