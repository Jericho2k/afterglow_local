# Afterglow

Afterglow is a multi-user character companion and roleplay studio. It combines editable character profiles, streamed multi-provider responses, chat regeneration, adult/SFW modes, and durable multi-layer memory in a polished web interface, built on Supabase for authentication, PostgreSQL, storage, and per-account data isolation.

It is an original application, not a copy of JuicyChat or Kindroid. The useful concepts are familiar; the code, interface, prompts, and data model are its own.

## What works now

- Creations: one flow that publishes a single character, a defined cast, or a scenario/RPG with no primary character at all
- Adaptive Creation Studio with progressive disclosure, autosaved drafts, platform tags and creator hashtags, reusable Worlds, and long-form openings
- AI-assisted character creation from a short concept
- Detailed backstory, personality, scenario, greeting, example voice, response directive, and boundaries
- Optional avatar URL and per-character visual accent
- Provider/model/RP-engine catalog with conversation-level switching; changing the writer never resets Afterglow continuity
- Streaming DeepSeek roleplay plus feature-gated OpenRouter models through the same provider adapter
- Regenerate the latest reply, edit any message, or rewind the story from any point
- Multiple named chats per character and chat breaks that preserve long-term memory
- Three-layer continuity:
  - persistent character profile and response rules
  - rolling story-so-far summary
  - relevance-ranked long-term memories and keyword journals
- Configurable automatic memory consolidation plus manual refresh
- Manual pinned journals with recall keywords; inspect, edit, pin, unpin, or delete memories
- Per-character adult/SFW mode, adult age gate, and explicit consent boundaries
- Supabase Auth accounts with email/password sign-up, sign-in, and persistent sessions
- Per-account ownership of every character, world, persona, chat, message, and memory, enforced by PostgreSQL row level security
- Character visibility model (private / unlisted / public) ready for a creator marketplace, with chats and memories that stay private even when the character is published
- Public creation pages that render only the sections a creator actually authored, and never expose the hidden prompt fields that steer the model
- Discovery feed with search, platform-tag filtering, three honest orderings and a private per-user saved library
- Opt-in creator profiles and a moderation-report queue
- Supabase Storage for profile and character images, scoped to the owning account
- Complete JSON export/import for profiles, chats, memories, and settings
- Request throttling, server-only API key, PostgreSQL persistence, local token-usage ledger, and Railway health check
- Responsive desktop/mobile UI

Image generation, voice/video calling, and group chat are not part of this release. They fit the architecture but each requires an additional provider and product pass; DeepSeek's chat endpoint itself does not provide those media capabilities.

## Run locally

Requirements: Node.js 22+, PostgreSQL 15+, and a Supabase project.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Supabase → Project Settings**, then apply the migrations (below). The application also creates any missing tables and columns at runtime, but row level security is only established by the migration files, so a deployment must apply them.

### Applying migrations

Run the files in `supabase/migrations` in order, either through the Supabase SQL editor or with psql:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0000_baseline.sql
psql "$DATABASE_URL" -f supabase/migrations/0001_multi_tenant_foundation.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_storage.sql
psql "$DATABASE_URL" -f supabase/migrations/0003_conversation_inference.sql
psql "$DATABASE_URL" -f supabase/migrations/0004_product_social.sql
psql "$DATABASE_URL" -f supabase/migrations/0005_openrouter_usage.sql
psql "$DATABASE_URL" -f supabase/migrations/0006_memory_retrieval_v2.sql
psql "$DATABASE_URL" -f supabase/migrations/0007_productization_sprint_1.sql
psql "$DATABASE_URL" -f supabase/migrations/0008_canonical_generated_user_messages.sql
psql "$DATABASE_URL" -f supabase/migrations/0009_public_character_profile.sql
psql "$DATABASE_URL" -f supabase/migrations/0010_world_covers_storage.sql
psql "$DATABASE_URL" -f supabase/migrations/0011_creation_model.sql
psql "$DATABASE_URL" -f supabase/migrations/0012_discovery_feed.sql
psql "$DATABASE_URL" -f supabase/migrations/0013_scene_state.sql
```

Every file is idempotent, so re-running them is safe. `0002_storage.sql` touches the `storage` schema and only applies to Supabase.

The application refuses to serve traffic against a database where it cannot assume the `authenticated` role, because row level security would silently not be enforced.

### Migrating existing single-owner data

The original schema has no concept of a user, so existing rows have to be assigned to one account explicitly.

1. Create the account (sign up in the app, or **Authentication → Users → Add user** in Supabase).
2. Copy its UUID.
3. Preview the migration, then apply it:

```bash
DATABASE_URL=… LEGACY_OWNER_USER_ID=<uuid> node scripts/migrate-legacy-owner.mjs
DATABASE_URL=… LEGACY_OWNER_USER_ID=<uuid> node scripts/migrate-legacy-owner.mjs --commit
```

The first run is a dry run that reports what it would claim and rolls back. Characters, worlds, personas, chats, messages, memories, arcs, usage events, and the settings row are all carried over. Once no unowned rows remain, re-run with `--commit --enforce` to make the ownership columns `NOT NULL`.

## Supabase setup

1. Create a Supabase project.
2. On the project creation screen, under **Security**, turn **Enable Data API** off and **Enable automatic RLS** on. Afterglow talks to PostgreSQL directly and uses Supabase only for Auth and Storage, so PostgREST is unused surface; automatic RLS is a free safety net for any table added later. Both are reversible in Project Settings.
3. Apply `supabase/migrations/0000_baseline.sql` and `0001_multi_tenant_foundation.sql`. The migration grants its own schema and table privileges, so it does not depend on the project's "automatically expose new tables" default.
4. Apply `supabase/migrations/0002_storage.sql`, which creates the `profile-avatars` and `character-avatars` buckets and their policies, then apply `0003_conversation_inference.sql`, `0004_product_social.sql`, `0005_openrouter_usage.sql`, and `0006_memory_retrieval_v2.sql`.
5. In **Authentication → Providers → Email**, keep Email enabled and turn **Confirm email** on. The app supplies a PKCE callback and a resend action.
6. In **Authentication → URL Configuration**, set **Site URL** to the deployed origin and add both `https://YOUR-DOMAIN/auth/callback` and `http://localhost:3000/auth/callback` to **Redirect URLs**.
7. In **Authentication → Email Templates → Confirm signup**, replace the template source with [`docs/supabase-confirmation-email.html`](docs/supabase-confirmation-email.html). Keep `{{ .ConfirmationURL }}` exactly as written; Supabase creates and signs that verification URL.
8. Send a test signup from both desktop and iPhone-width clients. Confirm that the button returns to `/auth/callback`, the app shows “Email verified,” expired links show a recoverable error, and **Resend email** produces a fresh message.
9. Copy `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into your host's environment.

No part of the application uses the service-role key. Ordinary reads and writes run as the signed-in account so row level security applies, and the legacy migration script connects with `DATABASE_URL` directly.

## Deploy

1. Push this repository to a **private** GitHub repository.
2. Create a project from it on your host (the included `Dockerfile` and `railway.toml` target Railway; `/api/health` is the health check).
3. Set `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `DEEPSEEK_API_KEY`.

   Use Supabase's **session pooler** connection string. The direct one (`db.<ref>.supabase.co`) resolves to IPv6 only, which most hosts cannot reach; `/api/health` reports `getaddrinfo ENOTFOUND` or `ENETUNREACH` when that is the problem.

   The two `NEXT_PUBLIC_*` values are inlined into the browser bundle while the image is built, not read when the container starts, so they must be present **before** the build runs. The Dockerfile declares them as build arguments and Railway passes service variables to the build automatically; on another host, pass them with `--build-arg`. Adding them to an already-built deployment has no effect until it is rebuilt, and the app now says so on its front page rather than failing silently.
4. Optionally enable OpenRouter with the server-only `ENABLE_OPENROUTER=true` and `OPENROUTER_API_KEY`. Add the desired catalog IDs to `ALLOWED_MODELS`: `minimax-m2-her`, `kimi-k2.5`, `glm-4.7`, `midnight-cherry`, `passion-fruit`, and `wild-peach`. `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` remain available for the direct provider.
5. To trial Memory Retrieval V2, apply migration `0006`, set `MEMORY_RETRIEVAL_V2_ENABLED=true`, and put the owner/test account UUID in `MEMORY_RETRIEVAL_V2_USER_IDS`. Keep `MEMORY_RETRIEVAL_V2_ALL_USERS=false` during beta. Semantic recall uses the same OpenRouter key with `MEMORY_EMBEDDING_MODEL=qwen/qwen3-embedding-8b` and `MEMORY_EMBEDDING_DIMENSIONS=1024`; failure automatically falls back to V1 lexical retrieval.
6. Apply migration `0007` for per-story response length/creativity and branch idempotency, then `0008` for canonical generated-user-message accounting. Set `AFTERGLOW_ADMIN_USER_IDS` to the comma-separated Supabase account UUIDs that may access memory diagnostics, tuning, manual consolidation, and the internal cost ledger. During transition, `MEMORY_RETRIEVAL_V2_USER_IDS` is used only when the explicit admin list is empty.

The admin ledger defines cost per 100 user messages as total recorded inference cost × 100 divided by distinct accepted user-authored message events. Regenerations, continuations, assistant replies, and background jobs can contribute cost to the numerator but never inflate the denominator; transcript copies created by branching retain the original authored event id.
6. Deploy, then open the domain, complete the adult age gate, and create an account.

The default provider, model, and RP engine apply only when a new conversation starts. Existing conversations retain all three and can switch them from chat tools without changing the transcript, rolling state, memories, arcs, character, world, or persona. `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`, `DEEPSEEK_MODEL`, and `DEFAULT_RP_ENGINE` set the deployment defaults. `RP_MODEL_ROUTE=conversation` respects that per-story writer, while `MEMORY_CONSOLIDATION_MODEL_ROUTE`, `MEMORY_CURATION_MODEL_ROUTE`, and `CHARACTER_IMPORT_MODEL_ROUTE` keep background work independent from it. Check the provider's official model documentation before changing IDs because model names evolve.

Railway's official deployment pattern is a Next.js service plus a referenced PostgreSQL `DATABASE_URL`; see [Deploy a Next.js app with Postgres](https://docs.railway.com/guides/nextjs).

## Memory design

With Memory Retrieval V2 enabled for an allowlisted account, each reply receives:

1. The full character profile and boundaries.
2. A strictly bounded conversation-specific Core Canon (normally 300–800 tokens, hard maximum 1,200).
3. A compact rolling relationship/story summary.
4. Hybrid semantic + lexical episodic memories with pinned/protected guarantees and paraphrase deduplication.
5. Relevant historical arcs from the permanent archive.
6. A configurable window of recent messages at full fidelity.

At the configured consolidation interval, the independently configured maintenance model condenses recent events into the summary and extracts a small set of atomic durable memories. Around every 100 messages, a separate conservative curation pass may promote, merge, supersede, or demote Core Canon entries. It never deletes the underlying episodic memories or historical arcs. Passwords, API keys, payment data, addresses, and explicit sexual mechanics are specifically excluded from automatic memory extraction.

This avoids continuously sending the entire chat history, improving continuity while controlling token cost. `memory_retrieval_runs` records selected IDs, tier token counts, deterministic score components and semantic fallback reasons; `usage_events` separately records RP, consolidation, curation, scene and embedding cost metadata.

### Scene State

Retrieval answers *what happened*. Scene State answers *where and when we are
now*, because a correctly recalled memory can still be misread as the present:
the same couch in another house, yesterday's argument treated as this morning's,
somebody who left the room still speaking. It is a small ledger — story day,
date only if the fiction stated one, time of day, location as place plus the
spot inside it, who is present, and a few unresolved beats — and nothing more.
It is not an RPG state engine: there is no inventory, no stats, no quest log.

Four rules keep it honest.

- **State persists until narrative evidence changes it.** Fifty messages of
  dialogue in one room are still that room, and still the same day. Message
  count is never story time.
- **Unknown stays unknown.** A story that never named a date does not get one.
  Relative chronology ("day 12", "three days later") is the primary mechanism;
  a calendar date appears only when the story stated one.
- **Selection stays relevance-driven.** Scene State changes how a retrieved
  memory is *presented*, not whether it is retrieved. The optional retrieval
  cue is behind its own flag and off by default.
- **Failure is invisible.** A failed extraction leaves the last good state in
  place, records a diagnostic row, and never touches the reply.

The writer receives a `CURRENT SCENE — THIS IS NOW` block above the archive,
and each recalled memory or arc that kept grounding is tagged with where and
when it happened (`[Day 4 · afternoon · university courtyard]`), so NOW and
THEN are labelled in opposite tenses. Measured over the benchmark fixtures the
block itself is 26–72 tokens and the whole addition to the writer prompt —
block, the NOW/THEN instruction and every history tag — averages 163 tokens.

One cheap background extraction runs after each reply on the independently
routed maintenance model — never the RP writer, never on the request path, and
never in the streamed text. Its static instructions sit in the system message
as one cacheable ~730-token prefix, leaving roughly 300 varying input tokens
and ~150 output tokens per turn. Its cost is recorded separately in
`usage_events` as `scene_state` and works out to roughly $0.011 per 100 user
messages on DeepSeek V4 Flash with prefix caching, or about $0.019 without it.

Scene rows are keyed by the same integer message position that memories use, so
a branch inherits only what was true at its branch point and an edit or rewind
discards the scene the abandoned future established. The state read through the
newest assistant reply also stores a fingerprint of that reply: a regenerated or
edited message no longer matches, so a discarded generation cannot leave its
location or cast behind. Scene State is internal metadata — it never appears in
a reply, and it is inspectable only through the admin-only `/api/scene-state`
diagnostics.

## Creation model

Everything a creator publishes is a **Creation**. A creation is authored as one
of three structures, and all three share the same feed, search, chats,
bookmarks and detail page:

| Structure | What it is | What the studio asks for |
| --- | --- | --- |
| Character | One primary character | Name, personality, backstory, scenario, optional supporting cast |
| Cast | Several defined characters sharing a premise | A card per character, plus the shared premise and history |
| Scenario / RPG | A situation, story or world | Premise, the reader's role, what the AI is responsible for, and *optional* important characters |

A scenario is never required to invent a primary character: with no cast
defined, the prompt tells the model to populate the world from the premise and
any attached World instead of handing it an empty character sheet.

Two distinctions matter throughout:

- **Creation title vs. character name.** "The Final War" and "Your New
  Roommate" are titles; `Emily Carter` is a name. Feed cards, heroes and chat
  headers use the title, resolved by `creationTitle` in `src/lib/creation.ts`.
  A creation written before titles existed has none, and its character name
  stands in — which is what those surfaces already displayed.
- **Platform tags vs. creator hashtags.** Tags come from the taxonomy in
  `src/lib/tags.ts` and drive filtering and recommendation. Hashtags are
  freeform creator vocabulary, stored normalised and without the leading `#`.
  They are stored, validated and presented separately and are never merged.

Migration `0011` is additive: `creation_type` is backfilled from
`profile_type`, `title` and `description` default to empty and fall back to the
name and the existing backstory text, and no chat, memory, like, comment or
world link is touched. Migration `0012` is index-only.

## Discovery

`/api/discovery` answers one page of public creations per request from a single
statement. The card summary it returns (`CreationSummary`) carries only public
presentation data — no greeting, personality, backstory, response directive,
boundaries, example dialogue, cast definition or import source material is
selected at all, so there is nothing to blank out for a visitor. Visibility is
enforced by `characters_select_own_or_published`, by an explicit
`visibility='public'` predicate, and by there being no code path that adds a
draft or unlisted row to the list.

Three orderings, each a plain sort over a real, trigger-maintained aggregate:

| Tab | Ordering |
| --- | --- |
| Popular | `like_count` (saves) desc, then `chat_count`, then recency |
| Most chatted | `chat_count` desc, then `message_count`, then recency |
| New | `published_at` desc |

There is deliberately no "For You": every account receives the same rows for
the same query, and no personalisation layer exists to make the label true.
Migration `0012` adds one partial index per ordering plus optional trigram
indexes for search, and changes no table, column, constraint or policy.

Search covers titles, names, taglines, descriptions, platform tags, creator
hashtags and creator names. A term written as `#mha` is looked up against
hashtags exactly rather than as letters inside a title, which keeps the two tag
systems distinct at query level as well as in storage.

## Saving

Save is the product's only affinity action, and it is one persistence model:
the `character_likes` relation and the `characters.like_count` counter its
SECURITY DEFINER trigger maintains. Those storage names predate the rename and
are kept — introducing a second bookmark table for the same user action would
be the expensive mistake, not the old column name. `character_likes` is
readable only by its owner, so the public total is visible to everybody while
nobody can enumerate who saved what.

Every surface goes through `toggleCreationSave` in `src/lib/saves.ts`, which
applies the change optimistically, settles on the server's authoritative total,
and reverts on failure. Likes are no longer a public metric anywhere in the UI.

## Adult-content boundaries

Adult mode permits consensual explicit fictional roleplay between adults. The system prompt still excludes minors or age ambiguity, coercion presented as consent, sexual violence, incest, bestiality, trafficking, and real-person sexual content. Provider-side restrictions may still apply; no application can promise that a hosted model will comply with every prompt.

## Security notes

- Never expose `DEEPSEEK_API_KEY` through a `NEXT_PUBLIC_` variable.
- Never expose `OPENROUTER_API_KEY` through a `NEXT_PUBLIC_` variable.
- Never commit `.env` or `.env.local`; both are ignored.
- Rotate any API key pasted into chat or another third-party interface before production use.
- Use Railway's secret variables and database backups.
- The application uses no service-role key at all. If you introduce one, keep it server-side: it bypasses row level security entirely.
- Ownership is enforced twice: every statement carries an explicit `user_id` predicate, and PostgreSQL policies decide independently. A mistake in one layer is caught by the other.
- Avatar buckets are public-read so published characters render for other accounts; writes are restricted to `users/{account_id}/…` by storage policy. Nothing confidential belongs in an avatar.
- Conversations, messages, memories, and arcs are private without exception, including when the character they use is public.

## Verification

```bash
npm test
npm run lint
npm run build
```

The cross-account isolation suite needs a real PostgreSQL, because the in-memory database used by the other tests implements neither roles nor policies:

```bash
createdb afterglow_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/afterglow_test npm test
```

Without `TEST_DATABASE_URL` those tests skip and everything else still runs. CI provides a PostgreSQL service so they always run there.

## Architecture

- Next.js 16 / React 19 / TypeScript
- Supabase Auth for accounts, Supabase Storage for images
- PostgreSQL through `pg`, with idempotent schema initialization and versioned migrations under `supabase/migrations`
- Row level security as the enforcement layer: each request runs in a transaction that assumes the `authenticated` role and publishes the caller's id as `request.jwt.claims`, so `auth.uid()` resolves for hand-written SQL exactly as it would through PostgREST
- Provider-adapter inference with direct DeepSeek and feature-gated OpenRouter chat/embedding endpoints, with NDJSON streaming to the browser
- Zod validation at every write endpoint
- Docker standalone build for Railway

## License and use

This repository is intended for private personal use. You are responsible for the laws, hosting rules, model-provider terms, and content involving your deployment.
