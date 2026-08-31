-- An intra-message consolidation cursor.
--
-- `last_consolidated_count` says how many whole messages have been folded into
-- continuity. It cannot say anything about a message that is larger than one
-- consolidation call can read, and the planner used to resolve that by clipping
-- the message to the ceiling, marking the clip in the prompt, and then advancing
-- the pointer past the WHOLE row. The marker was honest; the effect was not. The
-- tail was read by that call and by no later one, and nothing recorded that a
-- part of an accepted story message had been dropped.
--
-- `last_consolidated_offset` is where inside the first unconsolidated message the
-- next pass resumes, in characters. Zero — the overwhelmingly common state —
-- means "at the start of it", which is exactly the old behaviour. A pass that
-- reads a chunk without finishing the message advances this and leaves the count
-- alone; the count only moves once the final chunk has been read.
--
-- That is what makes the sequence restart-safe. A crash, a lease expiry or a
-- deploy between chunks resumes at the persisted offset instead of skipping to
-- the next row.
--
-- Anything that discards a future must reset both, or the story resumes reading
-- from an offset into a message that no longer exists; see
-- `invalidateDerivedContinuity`.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_consolidated_offset integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_consolidated_offset_non_negative
    CHECK (last_consolidated_offset >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
