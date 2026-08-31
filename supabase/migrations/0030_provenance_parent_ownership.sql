-- Provenance rows may only be attached to a story you own.
--
-- FOUND BY THE ROW-LEVEL-SECURITY SUITE, and it is not the obvious leak.
--
-- The policies added in 0028 said `user_id = auth.uid()`, which is correct as
-- far as it goes: nobody can read another account's provenance, and nobody can
-- write a row attributed to somebody else. What they did not say is anything
-- about the PARENT. A foreign key is checked by PostgreSQL as the table owner,
-- deliberately bypassing row level security, so `memory_id` and `message_id`
-- were free to point at rows the writer could not see.
--
-- On its own that leaks nothing readable — the owner's inspector resolves
-- versions with an explicit `user_id` predicate, so a stranger's row is
-- invisible to it. The damage is to the OWNER'S ABILITY TO RECORD HISTORY:
--
--   `memory_versions` is UNIQUE (memory_id, version). An account that inserts
--   (someone else's memory, version 2) makes it impossible for the real owner
--   to archive their own version 2 — and the archive write is
--   `ON CONFLICT DO NOTHING`, so their edit would silently proceed with the
--   original text unrecorded. The inspector would then resolve an older
--   generation's reference to "removed since" and show nothing, for a memory
--   that was merely edited.
--
--   `message_versions` and `message_generations` have the same shape, and for
--   generations the consequence is worse: a squatted (message_id, variant_index)
--   means a real generation's provenance is never recorded at all.
--
-- It is also an existence oracle. A foreign key violation and a successful
-- insert are distinguishable, so the old policies let anybody probe whether a
-- given memory or message id exists.
--
-- The fix is to require ownership of the parent as well as of the row. The
-- subquery carries its own `user_id = auth.uid()` predicate, so it is correct
-- whether or not row level security is also applied to the referenced table.

DROP POLICY IF EXISTS memory_versions_all_own ON memory_versions;
CREATE POLICY memory_versions_all_own ON memory_versions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM memories parent WHERE parent.id = memory_versions.memory_id AND parent.user_id = auth.uid())
  );

DROP POLICY IF EXISTS message_versions_all_own ON message_versions;
CREATE POLICY message_versions_all_own ON message_versions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM messages parent WHERE parent.id = message_versions.message_id AND parent.user_id = auth.uid())
  );

DROP POLICY IF EXISTS message_generations_all_own ON message_generations;
CREATE POLICY message_generations_all_own ON message_generations
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM messages parent WHERE parent.id = message_generations.message_id AND parent.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM conversations story WHERE story.id = message_generations.conversation_id AND story.user_id = auth.uid())
  );
