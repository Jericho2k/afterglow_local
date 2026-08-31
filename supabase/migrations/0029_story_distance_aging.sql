-- Forgetting measured in story, not in calendar days.
--
-- Retrieval aged memories by wall-clock time since they were written, and
-- demoted commitments out of the protected tier on the same clock. A roleplay
-- can sit untouched for three real months while five fictional minutes pass, so
-- a reader returning after a summer away found every promise stale and every
-- event faded inside a scene that had not moved at all.
--
-- Distance is now measured in messages and in story days, both of which are
-- already recorded on the row (`source_message_count`, `scene_story_day`).
--
-- `last_relevance_match_count` is the one new fact, and it exists because of a
-- loop. The natural staleness signal is "when was this last recalled", and it is
-- unusable: the protected tier recalls its own members on every turn, so a
-- commitment nobody has thought about in hundreds of messages keeps generating
-- fresh proof of its own relevance. `recall_count` and `last_recalled_at` are
-- downstream of the guarantee and can never justify it.
--
-- This column is written ONLY when a memory wins on its own merits — semantic,
-- lexical or scene relevance — and never when it was merely handed a guaranteed
-- slot. A promise the current scene is actually about keeps refreshing it; a
-- dead one does not, and eventually competes for a dynamic slot like everything
-- else. It is never resolved and never deleted by this: it loses a guarantee,
-- not its place in the archive.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_relevance_match_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_relevance_match_non_negative
    CHECK (last_relevance_match_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ranking reads every candidate for a story, so the aging inputs should be on
-- the same access path the archive listing already uses.
CREATE INDEX IF NOT EXISTS memories_story_distance_idx
  ON memories(user_id,character_id,conversation_id,status,source_message_count);
