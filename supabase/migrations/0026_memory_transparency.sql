-- Memory transparency and user memory management.
--
-- Two additions, both additive.
--
-- `messages.context_provenance` records WHAT ONE REPLY WAS WRITTEN FROM, beside
-- the memory and arc ids the row already carried. Recall provenance was already
-- truthful for the archive; it said nothing about the transcript window, the
-- core canon entries, the scene, or whether a rolling summary was in the
-- prompt. The inspector answers "what story context did Afterglow use", so the
-- answer has to be recorded rather than reconstructed — a reconstruction after
-- the fact would describe today's memories, not the ones that reply actually
-- read.
--
-- The memory columns make a reader-owned archive safe to edit. `origin`
-- separates what the consolidator extracted from what its owner wrote, and
-- supersession is recorded rather than deleted so that a message which recalled
-- a memory can still say what it recalled, and a canon entry can still name
-- what it was derived from.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'consolidation';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_origin_allowed
    CHECK (origin IN ('consolidation','user','import'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The inspector reads a run by the message it was produced for.
CREATE INDEX IF NOT EXISTS memory_retrieval_runs_message_idx
  ON memory_retrieval_runs(user_id,message_id);

-- Listing an owner's whole archive for one story is its own access path.
CREATE INDEX IF NOT EXISTS memories_owner_conversation_idx
  ON memories(user_id,character_id,conversation_id,status);
