-- Creations: character, cast, and scenario.
--
-- Everything a creator publishes is a Creation. It can be built around one
-- primary character, around several defined characters, or around a scenario
-- that the AI narrates and populates with NPCs — the last of which previously
-- had no representation at all, because the schema assumed one character per
-- published card.
--
-- Every column here is additive and defaulted so that existing rows keep
-- rendering exactly as they did:
--
--   * creation_type is backfilled from profile_type, so an ensemble card
--     becomes a cast and everything else a character. profile_type itself is
--     kept and kept in sync, because prompts, conversation snapshots and
--     backups still read it.
--   * title is empty for existing rows, and the application falls back to the
--     character's name — which is what those pages already displayed.
--   * description is empty for existing rows, and the public page falls back
--     to the backstory/personality text it already showed.
--
-- No chats, memories, likes, comments, world links or galleries are touched.

ALTER TABLE characters ADD COLUMN IF NOT EXISTS creation_type text NOT NULL DEFAULT '';
-- The public display title. Deliberately separate from `name`: "The Final War"
-- is not a person, and "Your New Roommate" is not what the character is called.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
-- Public premise shown as the Overview. Never the hidden AI definition, which
-- stays in backstory/personality/response_directive/boundaries.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
-- Who {{user}} plays. Optional for every creation type.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_role text NOT NULL DEFAULT '';
-- Creator-defined discovery hashtags, stored normalised and without the
-- leading "#". A separate system from the platform `tags` taxonomy, and never
-- merged with it.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_creation_type_known
    CHECK (creation_type IN ('', 'character', 'cast', 'scenario'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_hashtags_bounded
    CHECK (array_length(hashtags, 1) IS NULL OR array_length(hashtags, 1) <= 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill the structure that existing rows already implied. An empty
-- creation_type still resolves in the application, so this is a convenience
-- rather than a correctness requirement.
UPDATE characters
SET creation_type = CASE WHEN profile_type = 'ensemble' THEN 'cast' ELSE 'character' END
WHERE creation_type = '';

-- Hashtags are a discovery surface, so they are indexed the same way tags are.
CREATE INDEX IF NOT EXISTS characters_hashtags_idx ON characters USING gin (hashtags);
CREATE INDEX IF NOT EXISTS characters_creation_type_idx ON characters (creation_type) WHERE visibility = 'public';
