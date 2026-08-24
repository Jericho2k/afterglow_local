-- Rich content: creator-placed images inside three text surfaces.
--
-- The design decision worth stating plainly, because everything else follows
-- from it: the existing plain-text column stays canonical and keeps its exact
-- current meaning, and the structured blocks live beside it.
--
--   description       -> the text, exactly as before
--   description_rich  -> the blocks, when the creator used the rich editor
--
-- Writing both is what makes this safe. Every consumer that already reads the
-- text column — the roleplay prompt, the conversation snapshot, the backup
-- export, the discovery summary, an older client still open in a tab — keeps
-- reading it and keeps receiving text with no images in it. A decorative image
-- therefore cannot reach a model by being forgotten about somewhere: the code
-- paths that build model context never see a block at all.
--
-- The rich column is authoritative only for rendering. An empty array means
-- "this creation has no blocks", and the renderer falls back to the text —
-- which is what every existing row is, so nothing needs migrating.

-- Public creation description.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS description_rich jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The default opening.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS greeting_rich jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The alternate openings, index-aligned with `alternate_greetings`. An entry
-- may be an empty array, which means that particular opening is plain text.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS alternate_greetings_rich jsonb NOT NULL DEFAULT '[]'::jsonb;

-- World lore, which is the surface this feature exists for most of all: a
-- world page is long-form canon and benefits from maps and location art.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS content_rich jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_description_rich_array
    CHECK (jsonb_typeof(description_rich) = 'array' AND jsonb_array_length(description_rich) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_greeting_rich_array
    CHECK (jsonb_typeof(greeting_rich) = 'array' AND jsonb_array_length(greeting_rich) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_alternate_greetings_rich_array
    CHECK (jsonb_typeof(alternate_greetings_rich) = 'array' AND jsonb_array_length(alternate_greetings_rich) <= 12);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE worlds ADD CONSTRAINT worlds_content_rich_array
    CHECK (jsonb_typeof(content_rich) = 'array' AND jsonb_array_length(content_rich) <= 400);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
