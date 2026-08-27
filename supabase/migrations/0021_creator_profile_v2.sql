-- Creator Profile V2.
--
-- A creator profile was a name, a picture and a bio. This makes it an identity
-- worth building: who follows you, how much your work is actually being read,
-- where you stand among other creators, what you have earned, and what you have
-- published lately.
--
-- Every number here is REAL or it is absent. That constraint decides most of
-- the design below — in particular why "messages" gets its own counter instead
-- of reusing one that already exists, and why rank lives in a table instead of
-- being computed per page view.
--
-- Additive throughout. No existing column changes meaning, no table is
-- rewritten, and a deployment that stops here keeps working exactly as it does
-- today.

-- ---------------------------------------------------------------------------
-- Profile fields
-- ---------------------------------------------------------------------------

-- The banner behind the avatar. Same bucket and the same owner-scoped path
-- prefix as the avatar, because it is the same kind of object with the same
-- exposure: public to read, writable only inside `users/{id}/`.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_path text NOT NULL DEFAULT '';

-- The cosmetic ring around the avatar. Which values exist and which of them a
-- given creator has actually unlocked is decided in src/lib/cosmetics.ts and
-- enforced server-side on write; the column only guarantees a safe shape, so
-- adding a border later is not a migration.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_border text NOT NULL DEFAULT 'default';

-- Up to three achievements the creator chose to show first. Validated against
-- what they have genuinely unlocked before it is stored.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS featured_achievements text[] NOT NULL DEFAULT '{}';

-- Denormalised so a profile page never counts a follower table to draw a
-- number. Maintained by trigger below.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS follower_count integer NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_border_shape
    CHECK (profile_border ~ '^[a-z0-9_]{1,32}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_featured_achievements_bounded
    CHECK (array_length(featured_achievements, 1) IS NULL OR array_length(featured_achievements, 1) <= 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Following
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profile_follows (
  follower_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, creator_user_id)
);

-- Following yourself is not a thing, and the database is where that is settled
-- rather than in whichever route happens to write the row.
DO $$ BEGIN
  ALTER TABLE profile_follows ADD CONSTRAINT profile_follows_not_self
    CHECK (follower_user_id <> creator_user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Both directions are indexed: "who follows this creator" is the count, and
-- "who does this account follow" is the viewer's own list and their follow
-- state on every card they look at.
CREATE INDEX IF NOT EXISTS profile_follows_creator_idx ON profile_follows (creator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_follows_follower_idx ON profile_follows (follower_user_id, created_at DESC);

ALTER TABLE profile_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_follows FORCE ROW LEVEL SECURITY;

/*
 * Who may see a follow, and who may create one.
 *
 * A follow row names two people, and only those two may read it. That is a
 * deliberate product decision rather than a limitation: the FOLLOWER COUNT is
 * public, the follower LIST is not. A creator learning exactly which accounts
 * read their work is a different product with different consent, and the
 * aggregate is what the profile actually shows.
 *
 * Writing is narrower still: you may only ever create or delete your own
 * follow. There is no path by which one account can make another account
 * follow anybody.
 */
DROP POLICY IF EXISTS profile_follows_select_own ON profile_follows;
CREATE POLICY profile_follows_select_own ON profile_follows
  FOR SELECT TO authenticated
  USING (follower_user_id = auth.uid() OR creator_user_id = auth.uid());

DROP POLICY IF EXISTS profile_follows_insert_own ON profile_follows;
CREATE POLICY profile_follows_insert_own ON profile_follows
  FOR INSERT TO authenticated
  WITH CHECK (
    follower_user_id = auth.uid()
    -- Only a creator who has opted into a public profile can be followed.
    AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = creator_user_id AND p.username IS NOT NULL)
  );

DROP POLICY IF EXISTS profile_follows_delete_own ON profile_follows;
CREATE POLICY profile_follows_delete_own ON profile_follows
  FOR DELETE TO authenticated
  USING (follower_user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON profile_follows TO authenticated;

-- Counters. SECURITY DEFINER because a follower is by definition not the
-- creator, so the writer of the row can never update the creator's profile
-- directly — and must not be able to.
CREATE OR REPLACE FUNCTION public.refresh_follow_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  creator uuid;
  follower uuid;
BEGIN
  creator := CASE WHEN TG_OP = 'DELETE' THEN OLD.creator_user_id ELSE NEW.creator_user_id END;
  follower := CASE WHEN TG_OP = 'DELETE' THEN OLD.follower_user_id ELSE NEW.follower_user_id END;
  UPDATE profiles SET follower_count = (SELECT count(*) FROM profile_follows WHERE creator_user_id = creator) WHERE id = creator;
  UPDATE profiles SET following_count = (SELECT count(*) FROM profile_follows WHERE follower_user_id = follower) WHERE id = follower;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_follow_counts_trigger ON profile_follows;
CREATE TRIGGER profile_follow_counts_trigger
  AFTER INSERT OR DELETE ON profile_follows
  FOR EACH ROW EXECUTE FUNCTION public.refresh_follow_counts();

-- ---------------------------------------------------------------------------
-- What "messages" means
-- ---------------------------------------------------------------------------
--
-- `characters.message_count` counts EVERY message row: the reader's turns, the
-- model's replies, the opening greeting, and a fresh row for every regenerated
-- alternative. It is a fine number for "how busy is this creation" and it is
-- the wrong number for "how many messages have people sent to this creator's
-- work", which is what a creator profile claims. Quietly reusing it would
-- inflate the headline figure by roughly a factor of two.
--
-- So a second counter, with the definition stated once and enforced in one
-- place: a canonical user event that reached the model workflow, counted once
-- even if the story it was written in has since been branched.
--
--   role = 'user'                         a reply is not a message somebody sent
--   generation_started_at IS NOT NULL     it actually reached the writer
--   authored_event_id = id                the original, not a branch's copy
--
-- The same three conditions the creation page's own viewer-scoped count uses,
-- so the public total and the private one cannot disagree about what a message
-- is.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_message_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.bump_character_user_message_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_character_id uuid;
  delta integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role <> 'user' OR OLD.generation_started_at IS NULL OR OLD.authored_event_id IS DISTINCT FROM OLD.id THEN
      RETURN OLD;
    END IF;
    delta := -1;
    SELECT character_id INTO target_character_id FROM conversations WHERE id = OLD.conversation_id;
  ELSE
    IF NEW.role <> 'user' OR NEW.generation_started_at IS NULL OR NEW.authored_event_id IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;
    -- An update that merely touches an already-counted row must not count it
    -- twice. The transition that matters is the one where a user turn becomes
    -- canonical, which is when the writer accepted the request.
    IF TG_OP = 'UPDATE' AND OLD.generation_started_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    delta := 1;
    SELECT character_id INTO target_character_id FROM conversations WHERE id = NEW.conversation_id;
  END IF;

  IF target_character_id IS NOT NULL THEN
    UPDATE characters
    SET user_message_count = GREATEST(0, user_message_count + delta)
    WHERE id = target_character_id;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS character_user_message_count_trigger ON messages;
CREATE TRIGGER character_user_message_count_trigger
  AFTER INSERT OR DELETE OR UPDATE OF generation_started_at ON messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_character_user_message_count();

-- Exact backfill. `COUNT(DISTINCT COALESCE(authored_event_id, id))` rather than
-- the trigger's `authored_event_id = id`, because branch copies written before
-- 0008 introduced the lineage column were given their own id and can only be
-- de-duplicated this way. Both rules agree on every row written since.
UPDATE characters c
SET user_message_count = COALESCE((
  SELECT count(DISTINCT COALESCE(m.authored_event_id, m.id))
  FROM messages m
  JOIN conversations v ON v.id = m.conversation_id
  WHERE v.character_id = c.id AND m.role = 'user' AND m.generation_started_at IS NOT NULL
), 0);

CREATE INDEX IF NOT EXISTS characters_creator_popular_idx
  ON characters (user_id, user_message_count DESC, published_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'public';

-- ---------------------------------------------------------------------------
-- Creator standing
-- ---------------------------------------------------------------------------
--
-- Rank is a GLOBAL ordering, so answering "what is this creator's rank" from
-- scratch means ranking every creator on the platform. Doing that per page view
-- is exactly the kind of thing the last sprint spent its time removing, so the
-- answer is precomputed into one row per creator and refreshed on a timer.
--
-- The rule, stated once and implemented once:
--
--   PRIMARY   total user messages received across published creations
--   THEN      follower count
--   THEN      saves across published creations
--   THEN      published creation count
--   THEN      user id, so the order is total and stable rather than arbitrary
--
-- Only creators with a public username AND at least one published creation are
-- ranked. A private account is not competing, and a rank shared by ten thousand
-- creators with nothing published would make the number meaningless for the
-- ones who have.
CREATE TABLE IF NOT EXISTS creator_stats (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  published_creations integer NOT NULL DEFAULT 0,
  published_worlds integer NOT NULL DEFAULT 0,
  user_messages bigint NOT NULL DEFAULT 0,
  saves bigint NOT NULL DEFAULT 0,
  followers integer NOT NULL DEFAULT 0,
  rank integer,
  rank_total integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_stats_rank_idx ON creator_stats (rank) WHERE rank IS NOT NULL;

ALTER TABLE creator_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_stats FORCE ROW LEVEL SECURITY;

-- Public aggregates about public work: readable by any signed-in account,
-- writable by none of them. Only the refresh function, which runs as its
-- definer, may change a row.
DROP POLICY IF EXISTS creator_stats_select ON creator_stats;
CREATE POLICY creator_stats_select ON creator_stats
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON creator_stats TO authenticated;

-- One row, holding the last time the table was rebuilt. The atomic UPDATE
-- against it is how concurrent readers agree that exactly one of them does the
-- work; see `refreshCreatorStatsIfStale` in src/lib/creator-stats.ts.
CREATE TABLE IF NOT EXISTS creator_stats_refresh (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
INSERT INTO creator_stats_refresh (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE creator_stats_refresh ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_stats_refresh FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creator_stats_refresh_select ON creator_stats_refresh;
CREATE POLICY creator_stats_refresh_select ON creator_stats_refresh
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON creator_stats_refresh TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_creator_stats()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ranked integer;
BEGIN
  -- The whole table in one statement. Three grouped scans over indexed
  -- columns, and no per-creator query anywhere.
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
    WHERE p.username IS NOT NULL AND COALESCE(c.creations, 0) > 0
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
    SELECT 1 FROM profiles p
    JOIN characters c ON c.user_id = p.id AND c.visibility = 'public'
    WHERE p.id = s.user_id AND p.username IS NOT NULL
  );

  UPDATE creator_stats_refresh SET refreshed_at = now() WHERE id = true;
  RETURN ranked;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_creator_stats() TO authenticated;

-- ---------------------------------------------------------------------------
-- Achievements
-- ---------------------------------------------------------------------------
--
-- What an achievement IS lives in src/lib/achievements.ts: its title, its
-- description, its icon and the threshold it needs. This table holds only the
-- one thing code cannot derive — WHEN it was first true — and it holds it only
-- from the moment the system could observe it.
--
-- That is the honest form of the "do not fabricate historical unlock
-- timestamps" rule. A creator who passed ten thousand messages last year has
-- the achievement, because the metric says so; what they do not have is a
-- claim that it happened on a particular day, so no activity event is invented
-- for it. Future crossings are logged as they happen and become real history.
CREATE TABLE IF NOT EXISTS profile_achievements (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_id text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS profile_achievements_user_idx ON profile_achievements (user_id, unlocked_at DESC);

ALTER TABLE profile_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_achievements FORCE ROW LEVEL SECURITY;

-- Public-safe metadata about public work, so readable wherever the profile is;
-- writable only by the creator's own session, which is what makes an unlock
-- impossible to grant to somebody else.
DROP POLICY IF EXISTS profile_achievements_select ON profile_achievements;
CREATE POLICY profile_achievements_select ON profile_achievements
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = user_id AND (p.id = auth.uid() OR p.username IS NOT NULL)));

DROP POLICY IF EXISTS profile_achievements_write_own ON profile_achievements;
CREATE POLICY profile_achievements_write_own ON profile_achievements
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS profile_achievements_delete_own ON profile_achievements;
CREATE POLICY profile_achievements_delete_own ON profile_achievements
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON profile_achievements TO authenticated;

-- ---------------------------------------------------------------------------
-- Activity and milestones
-- ---------------------------------------------------------------------------
--
-- Publishing and updating are NOT stored here: `characters.published_at`,
-- `characters.updated_at` and the same two on `worlds` already hold those
-- timestamps exactly, and deriving the events from them means an existing
-- profile has a real history on the day this ships rather than starting empty
-- or starting with invented dates.
--
-- What is stored is everything with no timestamp of its own: an achievement
-- unlocking, a follower milestone, entering the top 100. `key` is what stops
-- the same threshold firing twice — a creator who crosses a thousand followers,
-- loses one and crosses it again has reached a thousand followers once.
CREATE TABLE IF NOT EXISTS profile_activity (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  key text NOT NULL DEFAULT '',
  title text NOT NULL,
  subject text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE profile_activity ADD CONSTRAINT profile_activity_kind_allowed
    CHECK (kind IN ('achievement', 'milestone', 'rank'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS profile_activity_user_idx ON profile_activity (user_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS profile_activity_key_idx ON profile_activity (user_id, key) WHERE key <> '';

ALTER TABLE profile_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_activity FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_activity_select ON profile_activity;
CREATE POLICY profile_activity_select ON profile_activity
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = user_id AND (p.id = auth.uid() OR p.username IS NOT NULL)));

DROP POLICY IF EXISTS profile_activity_write_own ON profile_activity;
CREATE POLICY profile_activity_write_own ON profile_activity
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON profile_activity TO authenticated;

-- Existing follower counts, for a database where rows somehow predate the
-- trigger. A no-op on a fresh install.
UPDATE profiles p SET
  follower_count = COALESCE((SELECT count(*) FROM profile_follows f WHERE f.creator_user_id = p.id), 0),
  following_count = COALESCE((SELECT count(*) FROM profile_follows f WHERE f.follower_user_id = p.id), 0);

SELECT public.refresh_creator_stats();
