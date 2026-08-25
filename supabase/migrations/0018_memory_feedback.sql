-- "She got this wrong."
--
-- The deterministic fixtures and the offline replay both produce evidence, and
-- both are approximations: one uses situations we invented, the other uses a
-- judge. This table is the only source of ground truth that comes from the
-- person who actually knows whether the character broke the story.
--
-- It is deliberately tiny, and it is deliberately a POINTER rather than a copy.
-- The row records which reply was wrong and which retrieval produced it; the
-- transcript stays where it already lives, under the same policies it already
-- has. Nothing here duplicates private content into a second place with a
-- second set of access rules to get wrong.
--
-- `retrieval_run_id` is the whole point. memory_retrieval_runs already stores
-- the recalled ids, the score details and the token allocations for every
-- generation, so one join turns "this reply was wrong" into "and here is
-- exactly what the ranker chose, and what it scored".

CREATE TABLE IF NOT EXISTS memory_feedback (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- Nullable: a reply generated before retrieval logging, or one whose run row
  -- was pruned, is still worth recording as a labelled failure.
  retrieval_run_id uuid REFERENCES memory_retrieval_runs(id) ON DELETE SET NULL,
  -- Mirrors src/lib/eval/taxonomy.ts. Kept as a constrained text column rather
  -- than an enum so adding a category is a code change, not a migration.
  category text NOT NULL CHECK (category IN (
    'forgot_something',
    'contradicted_itself',
    'brought_back_finished',
    'wrong_place_or_time',
    'confused_who_is_present',
    'other'
  )),
  -- Optional free text from the reader. Bounded so a note cannot become a
  -- second transcript.
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One label per reader per reply. Changing your mind updates the row.
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS memory_feedback_user_created_idx ON memory_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_feedback_run_idx ON memory_feedback(retrieval_run_id);

ALTER TABLE memory_feedback ENABLE ROW LEVEL SECURITY;

-- Strictly the reader's own labels. A creator must never be able to enumerate
-- which of their creation's replies somebody flagged, because the flag implies
-- what was in a private story.
DROP POLICY IF EXISTS memory_feedback_select_own ON memory_feedback;
CREATE POLICY memory_feedback_select_own ON memory_feedback
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS memory_feedback_insert_own ON memory_feedback;
CREATE POLICY memory_feedback_insert_own ON memory_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    -- The message and the conversation must both be the caller's, so a crafted
    -- id cannot attach a label to somebody else's story.
    AND EXISTS (SELECT 1 FROM messages m WHERE m.id = memory_feedback.message_id AND m.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = memory_feedback.conversation_id AND c.user_id = auth.uid())
  );

DROP POLICY IF EXISTS memory_feedback_update_own ON memory_feedback;
CREATE POLICY memory_feedback_update_own ON memory_feedback
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS memory_feedback_delete_own ON memory_feedback;
CREATE POLICY memory_feedback_delete_own ON memory_feedback
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_feedback TO authenticated;
