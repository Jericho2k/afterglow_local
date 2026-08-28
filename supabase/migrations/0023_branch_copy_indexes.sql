-- Branch creation reads a stable prefix of each continuity layer.  These
-- indexes match the equality/range predicates and deterministic tie-breakers
-- used by that path, so a 500-message branch does not scan or sort a whole
-- long-running story before the batched inserts begin.
CREATE INDEX IF NOT EXISTS messages_branch_prefix_idx
  ON public.messages (conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS memories_branch_prefix_idx
  ON public.memories (conversation_id, source_message_count, created_at, id);

CREATE INDEX IF NOT EXISTS memory_arcs_branch_prefix_idx
  ON public.memory_arcs (conversation_id, end_message_count, created_at, id);

CREATE INDEX IF NOT EXISTS core_canon_branch_prefix_idx
  ON public.core_canon_entries (conversation_id, source_message_count, created_at, id);

-- The existing unique (conversation_id, through_message_count) index serves
-- the range; this covering suffix preserves the deterministic newest-first
-- selection when multiple historical rows share a timestamp.
CREATE INDEX IF NOT EXISTS scene_states_branch_prefix_idx
  ON public.conversation_scene_states (conversation_id, through_message_count DESC, created_at DESC);
