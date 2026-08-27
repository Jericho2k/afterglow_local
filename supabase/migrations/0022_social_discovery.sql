-- Social discovery: attribution, notifications and rankings.
--
-- Creator Profile V2 (0021) built the identity. This makes it REACHABLE, and
-- gives the platform the two loops that make an audience worth having:
--
--   FOLLOW  -> a creator publishes -> the follower is told -> they come back
--   RANK    -> a reader finds the most-read work -> opens it -> finds its maker
--
-- Additive throughout. No existing column changes meaning, no table is
-- rewritten, and a deployment that stops here keeps working exactly as it does
-- today.

-- ---------------------------------------------------------------------------
-- Publishing is the opt-in to public attribution
-- ---------------------------------------------------------------------------
--
-- The bug this fixes: a creation published by an account with no username had
-- NO VISIBLE CREATOR to anybody except its owner. `profiles_select_own_or_public`
-- returns a profile only when it is your own or it has a username, so the join
-- on the creation page resolved for the owner and for nobody else. The page
-- then rendered its whole creator section conditionally on that row, so a
-- visitor saw an anonymous creation and the owner saw a byline. Same page, two
-- different truths, and the wrong one shown to everyone who mattered.
--
-- `username IS NOT NULL` was the consent signal, and it was the wrong signal:
-- it made a SEPARATE, easily-missed act the gate on attribution, while the act
-- that actually publishes work to strangers had no attribution consequence at
-- all. Publishing is the consent. Choosing to show your work to everyone is
-- choosing to be named as the person who made it.
--
-- So a username is now assigned at the moment of publishing. The one thing this
-- must never do is leak an email address, and that is a real risk rather than a
-- theoretical one: `handle_new_user` defaults `display_name` to
-- `split_part(email,'@',1)` when somebody signs up without typing a name. A
-- handle derived from that display name would publish half of their email
-- address to the entire platform.
--
-- Hence the function below reads `auth.users.email` — which is exactly why it
-- is SECURITY DEFINER and why the derivation cannot live in application code.
-- A display name that is still the email's local part is not a name the account
-- chose; it is a placeholder, and it is replaced by the same neutral handle
-- rather than being published.

/*
 * A username, derived or generated.
 *
 * Deterministic where it can be: "Nocturne Atelier" becomes `nocturne_atelier`,
 * and a collision appends the shortest numeric suffix that is free. Where it
 * cannot be — no display name, or a display name that is really an email — it
 * generates `creator_xxxxxxxx` from the account id, which is stable for the
 * account and says nothing about them.
 *
 * Returns the username the account ended up with. A no-op when one already
 * exists, so it can be called from anywhere as often as it likes.
 */
CREATE OR REPLACE FUNCTION public.ensure_public_username(account uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing text;
  chosen_name text;
  account_email text;
  local_part text;
  base text;
  candidate text;
  suffix integer := 0;
BEGIN
  SELECT username, display_name INTO existing, chosen_name FROM profiles WHERE id = account;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT email INTO account_email FROM auth.users WHERE id = account;
  local_part := lower(COALESCE(split_part(account_email, '@', 1), ''));

  -- A display name that is still the email's local part was never chosen; it
  -- is what the signup trigger fell back to. It is not published, and it is not
  -- used to derive a handle.
  IF local_part <> '' AND lower(COALESCE(chosen_name, '')) = local_part THEN
    chosen_name := NULL;
  END IF;

  base := regexp_replace(lower(COALESCE(chosen_name, '')), '[^a-z0-9]+', '_', 'g');
  base := trim(both '_' from base);
  -- The shape the CHECK constraint enforces: starts alphanumeric, 3-30 chars.
  IF base = '' OR length(base) < 3 OR base !~ '^[a-z0-9]' THEN
    base := 'creator_' || substr(replace(account::text, '-', ''), 1, 8);
  END IF;
  base := substr(base, 1, 30);
  base := trim(both '_' from base);
  IF length(base) < 3 THEN
    base := 'creator_' || substr(replace(account::text, '-', ''), 1, 8);
  END IF;

  candidate := base;
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE username = candidate);
    suffix := suffix + 1;
    -- The account id is unique, so this terminates: after a few collisions on
    -- a pretty handle it falls through to one built from the id itself.
    IF suffix > 40 THEN
      candidate := 'creator_' || substr(replace(account::text, '-', ''), 1, 12);
      EXIT;
    END IF;
    candidate := substr(base, 1, 30 - length(suffix::text) - 1) || '_' || suffix::text;
  END LOOP;

  UPDATE profiles
  SET username = candidate,
      -- Only when the stored name is the email placeholder. A real display
      -- name is never touched.
      display_name = CASE
        WHEN local_part <> '' AND lower(display_name) = local_part THEN candidate
        ELSE display_name
      END,
      updated_at = now()
  WHERE id = account AND username IS NULL;

  RETURN candidate;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_public_username(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
--
-- One purpose in v1: a creator you follow published something public. That is
-- deliberately narrow — a notification system whose first release already has
-- six event types has no way to learn which one people actually open — but the
-- SHAPE is general, so the second type is a row rather than a redesign.
--
-- `dedupe_key` is what makes generation idempotent. It is per recipient, so the
-- unique index is what a re-publish, a retried request, a double-fired trigger
-- and eventually a re-run background job all collide against. A creation that
-- goes public, private and public again notifies its followers once.

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  -- The RECIPIENT. Every policy on this table is about this column.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  -- Who did the thing. Null-able so a future system notification needs no
  -- fake actor.
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  /*
   * The creation this is about.
   *
   * ON DELETE CASCADE is the graceful handling of a deleted creation: the
   * notification goes with it rather than becoming a row that names something
   * nobody can open. A creation that is merely turned PRIVATE keeps its row —
   * it may come back — and is filtered out on read instead, which is why every
   * query below joins `characters` rather than trusting the stored row.
   */
  character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_allowed
    CHECK (type IN ('creation_published'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The feed's own ordering, so a page is a range scan rather than a sort.
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (user_id, created_at DESC, id DESC);

-- The bell. A partial index over unread rows only, because that is the
-- question the shell asks on every render and the answer has to be cheap: the
-- index holds one entry per unread notification per account, not one per
-- notification ever sent.
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Idempotency, enforced by the database rather than by whoever writes the row.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON notifications (user_id, dedupe_key);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

/*
 * Your notifications are yours.
 *
 * Read and update your own; that is the whole policy set, and the omission is
 * the interesting part: there is NO insert policy for `authenticated`. An
 * account cannot create a notification at all — not for somebody else, and not
 * for itself. The only writer is the fanout function below, which runs as its
 * definer. That is what makes "a creator cannot spam their followers' bells" a
 * property of the schema rather than of the routes.
 *
 * Update is granted on `read_at` alone. A recipient marking something read is
 * the only mutation the product has.
 */
DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own ON notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own ON notifications
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_delete_own ON notifications;
CREATE POLICY notifications_delete_own ON notifications
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT (id, user_id, type, actor_user_id, character_id, dedupe_key, created_at, read_at) ON notifications TO authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;
GRANT DELETE ON notifications TO authenticated;

/*
 * The fanout.
 *
 * ONE STATEMENT. Not a loop over followers, not a query per follower, and
 * emphatically not a browser walking a follower list — a creator with fifty
 * thousand followers is a set-based insert over an index, which is the
 * difference between a publish that returns and one that times out.
 *
 * It is a FUNCTION rather than inline trigger body precisely so that the day
 * this needs to move off the publishing request, it moves: a queue consumer
 * calls exactly this with exactly this argument, the trigger stops calling it,
 * and not one row shape, route or component changes. The product contract is
 * "rows appear in `notifications`", and nothing above this line knows how they
 * got there.
 *
 * SECURITY DEFINER because the publisher is by definition not the recipient,
 * so the account performing the publish has — and must have — no ability to
 * write these rows itself.
 *
 * Privacy is enforced in the WHERE clause and it is the whole guest list:
 * public and published only, so a draft, a private creation and an unlisted
 * one generate nothing. Followers only, so nobody hears about a creator they
 * did not choose.
 */
CREATE OR REPLACE FUNCTION public.fanout_creation_notifications(creation uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  delivered integer;
BEGIN
  INSERT INTO notifications (id, user_id, type, actor_user_id, character_id, dedupe_key)
  SELECT gen_random_uuid(), f.follower_user_id, 'creation_published', c.user_id, c.id,
         'creation_published:' || c.id::text
  FROM characters c
  JOIN profile_follows f ON f.creator_user_id = c.user_id
  WHERE c.id = creation
    AND c.visibility = 'public'
    AND c.published_at IS NOT NULL
    -- Following yourself is impossible, but a creator must not be notified
    -- about their own work even if that ever changes.
    AND f.follower_user_id <> c.user_id
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;

  GET DIAGNOSTICS delivered = ROW_COUNT;
  RETURN delivered;
END;
$$;

REVOKE ALL ON FUNCTION public.fanout_creation_notifications(uuid) FROM PUBLIC;

/*
 * When a creation becomes public.
 *
 * On the TRANSITION, not on every save. `published_at` is set by the routes on
 * the way to 'public' and nulled on the way out of it, so "was not published,
 * now is" is the whole condition — editing a creation that is already public
 * notifies nobody, which is what stops a creator's followers being pinged every
 * time a typo is fixed.
 *
 * A trigger rather than a call in `POST /api/characters`, because there are two
 * routes that publish (create and update) and there will be more. A creation
 * that is public is a creation whose followers were told, and the database is
 * where that stops depending on which endpoint was used.
 */
CREATE OR REPLACE FUNCTION public.announce_published_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.visibility <> 'public' OR NEW.published_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.visibility = 'public' AND OLD.published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Publishing is the moment attribution begins; see `ensure_public_username`.
  PERFORM public.ensure_public_username(NEW.user_id);
  PERFORM public.fanout_creation_notifications(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS character_published_trigger ON characters;
CREATE TRIGGER character_published_trigger
  AFTER INSERT OR UPDATE OF visibility, published_at ON characters
  FOR EACH ROW EXECUTE FUNCTION public.announce_published_creation();

-- A published world is public attribution too, even though it does not notify
-- in this release.
CREATE OR REPLACE FUNCTION public.announce_published_world()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.visibility = 'public' THEN PERFORM public.ensure_public_username(NEW.user_id); END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS world_published_trigger ON worlds;
CREATE TRIGGER world_published_trigger
  AFTER INSERT OR UPDATE OF visibility ON worlds
  FOR EACH ROW EXECUTE FUNCTION public.announce_published_world();

/*
 * Existing creators, named.
 *
 * Everybody who has already published gets the handle they would have been
 * given had they published today. This is a BACKFILL OF ATTRIBUTION and
 * deliberately NOT a backfill of notifications: nothing below invents a history
 * of releases that nobody was told about at the time. Notifications begin now.
 */
DO $$
DECLARE
  account uuid;
BEGIN
  FOR account IN
    SELECT DISTINCT p.id FROM profiles p
    WHERE p.username IS NULL
      AND (EXISTS (SELECT 1 FROM characters c WHERE c.user_id = p.id AND c.visibility = 'public')
        OR EXISTS (SELECT 1 FROM worlds w WHERE w.user_id = p.id AND w.visibility = 'public'))
  LOOP
    PERFORM public.ensure_public_username(account);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Creation rankings
-- ---------------------------------------------------------------------------
--
-- Same metric as the creator standing, one level down: USER messages sent to a
-- published creation. Not `message_count`, which counts the model's replies,
-- the opening greeting and every regenerated alternative as well and would
-- roughly double the figure; `user_message_count`, whose definition is stated
-- once in 0021 and enforced by one trigger.
--
-- Two shapes in one table:
--
--   category = ''      the overall ordering, every eligible creation
--   category = 'Drama' the ordering within one controlled taxonomy tag
--
-- A creation appears once per category it carries plus once overall, so
-- "#5 in Drama, #22 in Romance, #147 overall" is three rows and no arithmetic.
--
-- Only PUBLIC creations rank. Not private, not drafts, and deliberately not
-- unlisted: unlisted means "I have a link for you", and a leaderboard is the
-- opposite of a link you were given. Every discovery index in this schema is
-- already `WHERE visibility = 'public'`, so this agrees with the rest of the
-- product rather than inventing a fourth meaning for eligibility.

CREATE TABLE IF NOT EXISTS creation_rankings (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  /** '' is the overall board. Anything else is a controlled taxonomy tag. */
  category text NOT NULL DEFAULT '',
  rank integer NOT NULL,
  /** How many creations were in this board when it was computed. */
  rank_total integer NOT NULL DEFAULT 0,
  user_messages integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, category)
);

-- Reading a board: "the first fifty of Drama" is a range scan.
CREATE INDEX IF NOT EXISTS creation_rankings_board_idx ON creation_rankings (category, rank);
-- Reading one creation's achievements: at most a handful of rows, best first,
-- which is exactly what the badge rule on the creation page asks for.
CREATE INDEX IF NOT EXISTS creation_rankings_creation_idx ON creation_rankings (character_id, rank);

ALTER TABLE creation_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE creation_rankings FORCE ROW LEVEL SECURITY;

/*
 * Public aggregates about public work.
 *
 * Readable by any signed-in account and writable by none of them — only the
 * refresh function, running as its definer, may change a row. There is nothing
 * private to protect here by construction: the table contains a position and a
 * count of messages, never who sent one or what it said, and only ever for
 * creations that are already public.
 */
DROP POLICY IF EXISTS creation_rankings_select ON creation_rankings;
CREATE POLICY creation_rankings_select ON creation_rankings
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON creation_rankings TO authenticated;

-- The same one-row clock `creator_stats_refresh` uses, and for the same reason:
-- the atomic UPDATE against it is how concurrent readers agree that exactly one
-- of them rebuilds the boards. See `refreshCreationRankingsIfStale`.
CREATE TABLE IF NOT EXISTS creation_rankings_refresh (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
INSERT INTO creation_rankings_refresh (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE creation_rankings_refresh ENABLE ROW LEVEL SECURITY;
ALTER TABLE creation_rankings_refresh FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creation_rankings_refresh_select ON creation_rankings_refresh;
CREATE POLICY creation_rankings_refresh_select ON creation_rankings_refresh
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON creation_rankings_refresh TO authenticated;

/*
 * The boards, rebuilt.
 *
 * Two grouped scans over one partial index, and no per-creation query
 * anywhere. `row_number` rather than `rank`, deliberately: a leaderboard with
 * four creations at #1 is not a leaderboard, and the ordering already carries
 * enough tie-breakers to be a TOTAL order —
 *
 *   PRIMARY   user messages received
 *   THEN      saves
 *   THEN      stories started
 *   THEN      published first
 *   THEN      id, so the result is stable rather than arbitrary
 *
 * — which means the same input always produces the same board, and a reader
 * paging through it never sees a creation twice or misses one.
 *
 * `categories` is the platform taxonomy, passed in by the caller rather than
 * hardcoded here, so adding a genre is a constant in TypeScript and not a
 * migration. Creator hashtags are NOT eligible and cannot be: they are freeform
 * text, and a ranking category anybody can mint is a ranking nobody can trust.
 */
CREATE OR REPLACE FUNCTION public.refresh_creation_rankings(categories text[], board_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ranked integer;
BEGIN
  /*
   * Only the top of each board is stored, and that is a measured decision
   * rather than a shortcut.
   *
   * Ranking every public creation in every category it carries is not the
   * expensive part — the window functions are one pass. WRITING it is: on a
   * platform of 120,000 creations the boards come to about 334,000 rows, and
   * upserting them took 14.8 seconds. That work happens inside whichever
   * reader's request wins the refresh claim, so it is 14.8 seconds somebody
   * spends looking at a spinner, and it grows with the platform.
   *
   * Nothing needs those rows. The creation page only mentions a rank at 100 or
   * better, and no reader has ever paged to the nine-hundredth entry of a
   * leaderboard. Storing the top `board_size` of each board keeps every number
   * the product actually shows and turns the write into a few thousand rows.
   *
   * `rank_total` is still the TRUE size of the field, because the window
   * computes it over everything eligible before this filter applies — so
   * "#5 of 12,480 in Drama" remains exactly true.
   */
  CREATE TEMP TABLE fresh_rankings ON COMMIT DROP AS
  WITH eligible AS (
    SELECT c.id, c.tags, c.user_message_count, c.like_count, c.chat_count, c.published_at
    FROM characters c
    WHERE c.visibility = 'public'
  ), overall AS (
    SELECT id AS character_id, '' AS category, user_message_count,
           row_number() OVER (
             ORDER BY user_message_count DESC, like_count DESC, chat_count DESC,
                      published_at DESC NULLS LAST, id
           )::integer AS rank,
           count(*) OVER ()::integer AS rank_total
    FROM eligible
  ), boards AS (
    -- The category list, once, with its lookup key alongside it.
    SELECT name, lower(name) AS key FROM unnest(categories) AS name
  ), tagged AS (
    /*
     * One row per (creation, board it belongs to).
     *
     * Written as "expand each creation's own tags and match them against the
     * list" rather than "for each category, test every creation". The two are
     * equivalent and the costs are not: a creation carries two or three tags,
     * so this is a couple of hundred thousand rows joined to a fifteen-row
     * list, where the other form evaluated an EXISTS for every creation in
     * every category and did nearly two million subquery probes.
     *
     * Matched case-insensitively because `characters.tags` accepts free input,
     * so "romance" typed by hand is the same board as "Romance" chosen from
     * the picker.
     */
    SELECT DISTINCT e.id, b.name AS category,
           e.user_message_count, e.like_count, e.chat_count, e.published_at
    FROM eligible e
    CROSS JOIN LATERAL unnest(e.tags) AS raw(value)
    JOIN boards b ON b.key = lower(raw.value)
  ), by_category AS (
    SELECT t.id AS character_id, t.category, t.user_message_count,
           row_number() OVER (
             PARTITION BY t.category
             ORDER BY t.user_message_count DESC, t.like_count DESC, t.chat_count DESC,
                      t.published_at DESC NULLS LAST, t.id
           )::integer AS rank,
           count(*) OVER (PARTITION BY t.category)::integer AS rank_total
    FROM tagged t
  )
  SELECT * FROM overall WHERE rank <= board_size
  UNION ALL
  SELECT * FROM by_category WHERE rank <= board_size;

  INSERT INTO creation_rankings (character_id, category, rank, rank_total, user_messages, computed_at)
  SELECT character_id, category, rank, rank_total, user_message_count, now() FROM fresh_rankings
  ON CONFLICT (character_id, category) DO UPDATE SET
    rank = EXCLUDED.rank,
    rank_total = EXCLUDED.rank_total,
    user_messages = EXCLUDED.user_messages,
    computed_at = now();

  GET DIAGNOSTICS ranked = ROW_COUNT;

  -- A creation that was unpublished, deleted, or had a tag removed stops being
  -- ranked rather than keeping the position it held when it last qualified.
  DELETE FROM creation_rankings r
  WHERE NOT EXISTS (
    SELECT 1 FROM fresh_rankings f
    WHERE f.character_id = r.character_id AND f.category = r.category
  );

  UPDATE creation_rankings_refresh SET refreshed_at = now() WHERE id = true;
  DROP TABLE fresh_rankings;
  RETURN ranked;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_creation_rankings(text[], integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- Indexes the new surfaces read through
-- ---------------------------------------------------------------------------

-- The Following feed: "everything this creator published, newest first",
-- looked up once per followed creator by the join. Without it, a feed for
-- somebody who follows forty creators is forty scans of the public table.
CREATE INDEX IF NOT EXISTS characters_creator_published_idx
  ON characters (user_id, published_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'public';

-- The overall board's own ordering, so the first page of Rankings is a range
-- scan even in the moment before the materialised table has been built.
CREATE INDEX IF NOT EXISTS characters_messages_idx
  ON characters (user_message_count DESC, like_count DESC, id DESC)
  WHERE visibility = 'public';

-- Creator boards, ordered by the standing's primary metric.
CREATE INDEX IF NOT EXISTS creator_stats_messages_idx
  ON creator_stats (user_messages DESC, followers DESC, user_id);
