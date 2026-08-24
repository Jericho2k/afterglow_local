-- Discovery feed indexes.
--
-- No table, column, constraint or policy changes: the feed answers entirely
-- from data the product already stores. Saves are `character_likes` and the
-- `like_count` counter its trigger maintains, stories are `chat_count`, and
-- replies are `message_count`. Renaming any of those would rewrite working
-- history for a vocabulary change, so the storage keeps its names and the
-- product calls the concept Save.
--
-- Everything below is additive and idempotent.

-- ---------------------------------------------------------------------------
-- Orderings
--
-- One partial index per feed tab, each matching that tab's ORDER BY exactly so
-- a page is a range scan rather than a sort of every public creation. Partial
-- on `visibility = 'public'` because discovery never reads anything else.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS characters_discovery_new_idx
  ON characters (published_at DESC NULLS LAST, created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS characters_discovery_popular_idx
  ON characters (like_count DESC, chat_count DESC, published_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS characters_discovery_chatted_idx
  ON characters (chat_count DESC, message_count DESC, published_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'public';

-- Reading back a creation's own saves, which the save endpoint does once per
-- write. The existing character_likes_user_idx covers the other direction.
CREATE INDEX IF NOT EXISTS character_likes_character_idx
  ON character_likes (character_id);

-- ---------------------------------------------------------------------------
-- Search
--
-- Free-text search is a substring match over the public copy, which no btree
-- index can serve. pg_trgm can, so it is used where it is available and simply
-- skipped where it is not: a database without the extension still answers the
-- same queries, just by scanning. The feed is otherwise unaffected, which is
-- why this is allowed to fail quietly rather than block the migration.
--
-- Tag and hashtag lookups already have their gin indexes from 0009 and 0011,
-- and the feed's `&&` overlap predicates use them.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable; discovery search will scan instead of using a trigram index';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS characters_discovery_title_trgm_idx
      ON characters USING gin (title gin_trgm_ops) WHERE visibility = 'public';
    CREATE INDEX IF NOT EXISTS characters_discovery_name_trgm_idx
      ON characters USING gin (name gin_trgm_ops) WHERE visibility = 'public';
    CREATE INDEX IF NOT EXISTS characters_discovery_tagline_trgm_idx
      ON characters USING gin (tagline gin_trgm_ops) WHERE visibility = 'public';
  END IF;
END $$;
