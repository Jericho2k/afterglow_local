# Background inference: memory routing, the Scene Ledger, and what it now costs

What changed in the background workload, what it is measured at, and what is
still unproven. Written for whoever has to change it at three in the morning.

The RP writer architecture is untouched. Everything here is work that happens
after a reply has already been delivered.

> **Corrected in production.** Two of the routes described here failed with
> `empty_response` once real traffic reached them — Ling was sent a
> `response_format` it does not implement, and DeepSeek 0731 was never told not
> to reason inside a 3,600-token envelope — and the failures were invisible
> because nothing recorded whether background work was happening at all. See
> **`background-empty-response-2026-09.md`** for the causes, the wire shapes
> before and after, the bounded memory fallback and the operator visibility that
> answers it.

---

## 1 — Memory model routing: before

`taskModelSelection()` read one environment variable per job:

| job | variable | shipped value |
|---|---|---|
| memory consolidation | `MEMORY_CONSOLIDATION_MODEL_ROUTE` | unset → `deepseek:deepseek-v4-flash` |
| canon curation | `MEMORY_CURATION_MODEL_ROUTE` | unset → `deepseek:deepseek-v4-flash` |
| Scene State | `SCENE_STATE_MODEL_ROUTE` | unset → `deepseek:deepseek-v4-flash` |
| character import | `CHARACTER_IMPORT_MODEL_ROUTE` | unset → `deepseek:deepseek-v4-flash` |

So the smallest unit of change was a deploy, which is why the incumbent had
never been challenged by anything except an argument. An A/B nobody can run in
an afternoon is an A/B nobody runs.

**A second defect was found while auditing this**, and it was not about cost.
Background calls never passed the catalogue `modelId` into
`completionWithUsage`, so `providerBlock()` had nothing to look up and sent
OpenRouter **no `provider` block at all** — no `max_price` ceiling, and, more
seriously, no `data_collection: "deny"` on requests carrying a reader's
transcript. Every background call now passes it. See `src/lib/memory.ts`,
`src/lib/memory-v2.ts`, `src/lib/scene-state-store.ts`.

## 2 — The admin selector

`background_model_routes` (deployment-global, one row per job) is the normal
runtime control. Four layers, most specific first:

1. **per-conversation override** — `conversations.memory_model_override` /
   `scene_model_override`, admin-only, for a controlled side-by-side inside one
   story.
2. **global admin setting** — the row. **This is the normal control.**
3. **environment route** — unchanged, now the emergency lever that still works
   when the database does not.
4. **code default**.

A stored setting that has become unselectable (provider disabled, verification
withdrawn) falls through to the next layer rather than failing the job; the
admin API refuses to *store* one, which is what stops an administrator creating
that state by accident.

`GET|PUT /api/admin/background-routing` — API. Panel: `BackgroundModelPanel` in
the chat's operator tools, beside the Scene Ledger diagnostics.

**Nothing is ever regenerated when the setting changes.** There is no migration
path in `src/lib/background-routing.ts` and adding one would be a product
decision, not a routing one. Asserted in
`tests/background-routing.test.ts` → "changing the setting never rewrites
history".

### Provenance

Every background usage row already carried logical model, actual provider model,
upstream provider, task route, tokens, cached tokens and cost. It now also
carries `provider_metadata.routing = { task, candidate, source }` — **which
layer decided**. Without it two weeks of consolidations on a cheaper route are
indistinguishable from two weeks of a stale environment variable.

## 3 — The available memory models

| candidate id | route | selectable |
|---|---|---|
| `direct_deepseek` | `deepseek:deepseek-v4-flash` | yes — the incumbent and the control |
| `deepseek_0731` | `openrouter:deepseek-v4-flash-0731` | yes — host chosen by the usual policy |
| `deepseek_0731_openinference` | `openrouter:deepseek-v4-flash-0731-openinference` (`provider.only: open-inference/fp8`) | **gated — needs operator opt-in** |
| `deepseek_0731_relace` | `openrouter:deepseek-v4-flash-0731-relace` (`provider.only: relace/fp4`) | **gated — needs operator opt-in** |
| `mimo_v25` | `openrouter:mimo-v2.5` | yes |
| `ling_3_flash` | `openrouter:ling-3.0-flash` | yes — **no `response_format`**; asked for JSON in words |
| `off` | — | Scene Ledger only |

### The verified tags, and why the guesses were wrong

The first version of these entries carried `openinference` and `relace` — the
obvious lowercase forms of two host names. Checked against OpenRouter's endpoint
list for `deepseek/deepseek-v4-flash-0731`, the real routing tags are:

| tag | fresh | cached | output |
|---|---|---|---|
| `open-inference/fp8` | $0.05/M | $0.013/M | $0.16/M |
| `relace/fp4` | $0.065/M | $0.016/M | $0.18/M |

A hyphen nobody would have added, and a quantisation suffix nobody would have
known to look for. That is the argument for having refused to enable them on a
plausible-looking guess: pinning a host is `provider.only` with fallbacks off,
so a wrong tag is not a slower route — it is a background job that fails on
**every** run, silently, because background jobs never reach a reader to
complain.

**The suffix is part of the route, not decoration.** `fp8` and `fp4` name the
quantisation the host serves this model at, which is precisely the difference
the per-host A/B exists to measure. Opting into `relace` is not opting into a
precision nobody looked at, and the selector refuses the bare host name.

### `safeId` silently unpinned both of them

`safeId` rejects `/`, correctly, for the things it guards — catalogue model ids,
environment keys, anything that has to survive being pasted into a variable.
Running `open-inference/fp8` through it returned false, which produced **no
error anywhere**: `dedicatedProviderFor` answered null and
`approvedProviderPool` answered an empty list, so a model deliberately pinned to
one host would have been routed by OpenRouter's own default policy instead. A
hard pin failing *open*, quietly, in exactly the direction the pin exists to
prevent.

The fix is a second, narrower predicate — `safeProviderTag` — used **only**
where an upstream routing tag is validated:

- `dedicatedProviderFor` / `approvedProviderPool` (the pins and the pools)
- `poolOverrideFor` (`PROVIDER_POOL_OVERRIDE`)
- `pinnedProviderFor` (`PIN_UPSTREAM_PROVIDER`)
- the `ignore` list built from hosts that already failed this request — a
  slashed tag has to be excludable or recovery goes straight back to the host
  that just went quiet.

It accepts up to three `[A-Za-z0-9._-]` segments separated by `/`, each starting
and ending alphanumeric; it refuses empty segments, leading and trailing
slashes, `.`/`..`, whitespace, quotes and every other punctuation mark.
`safeId` is unchanged and still guards `ALLOWED_MODELS`.

### Staying verified

```
OPENROUTER_API_KEY=… node scripts/background-route-verify.mjs
```

It no longer hunts for a plausible-looking host: it asks whether those two exact
strings are still served, prints their live prices and quantisation, and prints
the environment line. A tag that has been renamed upstream is reported as
related-but-different and deliberately **not** printed into the line — the
catalogue entry in `src/lib/provider.ts` has to be corrected first, or the pin
points at a tag the code does not carry.

The gate stays even though the tags are correct, because what it asks for is
consent rather than spelling: naming a host in
`BACKGROUND_ROUTE_VERIFIED_UPSTREAMS` is an operator saying they are willing to
send readers' transcripts through it.

## 4 — Memory prompt layout, before and after

Measured through the real builder over 20 consecutive consolidation jobs
(`tests/memory-cacheability.test.ts`, `npx vitest run tests/memory-cacheability.test.ts`):

| layout | average reusable prefix |
|---|---|
| rules last, one user message (original) | **0.5%** |
| rules in system message, summary first | **41.1%** |
| rules in system message, commitments first (current) | **44.9%** |

Nothing was removed between those three. The same rules, schema, summary,
commitments and transcript are sent in all of them; only their order moved.

The second move is the one this sprint added: the dynamic half is now ordered by
**how fast each block changes**. Open commitments are identical between most
consecutive jobs; the rolling summary is different between all of them, because
it is the previous job's own output. With the summary first, everything behind
it was a guaranteed miss.

Composition of one job at ~20 jobs in:

```
static extraction rules   732 tokens   ← reused on every job
open commitments          125 tokens   ← reused on 13 of 20
rolling summary           766 tokens   ← never reused, by construction
new transcript            483 tokens   ← never reused, by construction
```

**44.9% is close to the structural ceiling and should not be "improved".** A
consolidation job is inherently a new-material job. The only way to raise the
percentage is to send less memory context, which is precisely what this sprint
must not do — so `tests/memory-cacheability.test.ts` asserts the pieces are
present and substantial alongside the ratio.

### Determinism

Audited for cache-busting values ahead of the reusable prefix. None found:
no timestamps, no request ids, no random ids, no counters. Commitment ordering
is total (`commitmentResolutionCandidates`: pinned, then oldest, then id).
Transcript ordering is `created_at, id`. `serializePayload(payload(n))` is
asserted byte-identical across two builds.

## 5 — The memory inference session

`memory_consolidation` is now a sticky task:

```
inferenceSessionId("memory_consolidation", conversationId)
```

The old comment said "the prefix is different every time" — true of the *old*
prompt, where the rules sat behind the transcript. With ~730 stable tokens at
the head and consolidations minutes apart, stickiness is exactly what keeps a
host holding the prefix between jobs.

`memory_curation` stays **unsticky**, and the reason is its cadence rather than
its prompt: canon is curated every 75–150 messages, hours or days apart, and no
provider holds a cache over that interval. If the interval ever drops to
minutes, revisit `src/lib/inference-session.ts`.

Namespaces remain separate — `rp_generation`, `memory_consolidation`,
`memory_curation`, `scene_state` — because their prefixes share nothing.

## 6 — Scene State → Scene Ledger Lite

### Removed

- per-actor `posture`, `facing`, `relativeTo`, `support`
- `leftArm`, `rightArm`, `leftHand`, `rightHand`, `leftLeg`, `rightLeg`,
  `leftFoot`, `rightFoot`
- `held` (item microtracking)
- `contacts` (the contact graph)
- `constraints`
- `activeSituation` (the prose beat list)

### Kept

```jsonc
{
  "storyDay": 12,
  "dateKind": "exact | relative | unknown",
  "dateText": "2026-09-02" | "the day after the festival" | "",
  "time":     { "kind": "exact | approximate | period | relative | unknown", "text": "21:37" },
  "location": { "place": "Maya's apartment", "sub": "living room", "confidence": "stated | inferred | unknown" },
  "present":  [ { "name": "User", "position": "on sofa" },
                { "name": "Maya", "position": "beside User" },
                { "name": "Anna", "position": "near window" } ]
}
```

**Time precision is now declared and never promoted.** The old two-field model
(broad period + optional exact clock) could not hold "around 9 PM" or "a few
minutes later" without inventing precision or losing it. A value labelled
`exact` that is not a clock reading is demoted to `approximate` — the one
direction that can fabricate information is the one that is checked.

**Presence is maintained by arrival and departure, never by restatement.** An
extraction window is a few messages long and can never be evidence that somebody
is *absent*, so a `present` list is additive and only `departed` removes anybody.
That is the fix for the reported failure: three people enter, the user talks to
one for thirty messages, the other two used to evaporate.

A day advance clears the roster (yesterday's room is not evidence about this
morning). A relocation keeps the people and clears the positions (walking to the
kitchen together leaves nobody behind, and "on the sofa" is not true there).

### Two renderings: the facts, and the writer's rule

The ledger has two audiences and they need different things.

- `renderSceneLedger(fields)` — **state only.** Day, date, time, place, who is
  here and roughly where. This is what `GET /api/scene-state` returns as
  `rendered` and what the operator panel displays.
- `scenePersistenceRule` — *"Everyone listed under Present is still here. Do not
  write them out of the scene unless the story moves them."* An instruction to a
  writer, exported separately.
- `renderCurrentScene(fields)` — the facts **then** the rule. What
  `buildWriterPrompt` sends, what the stored `token_count` measures, and what
  the API returns as `writerBlock` for comparing a prompt against the state.

The rule was previously inside the single rendering function, so the
administrator diagnostic displayed an instruction to a model as though it were
something the ledger believed. The fix is structural rather than a filter: the
factual function cannot reach the rule, so the leak cannot return by somebody
forgetting to strip a line.

### Storage

`present_people jsonb` and `time_kind text` added. The physical columns are
**retained, empty** — they stop being written and read, which is the whole
behaviour change; dropping them would make a rollback lossy for no operational
gain. Rows written before this release read correctly: names with no positions,
and a stored period read back as a period.

## 7 — Trigger rules

| action | ledger |
|---|---|
| accepted reply (`send`) | eligible for update |
| `continue` | eligible — the story genuinely advances |
| `regenerate` | **never updated** |

`maybeUpdateSceneState` moved *below* the `if (regenerateTarget) return;` guard
in the chat route. Beyond the cost, this was a correctness fix: four
regenerations used to have the ledger read four different futures in turn, and
the one that stuck was whichever finished last rather than whichever the reader
kept. The selected variant becomes canonical when the story proceeds from it,
and the next accepted turn extracts through it.

## 8 — The static-turn skip

Deterministic, in `sceneUpdateSkippable`. **No model is called to decide whether
to call a model.**

Runs the extractor when any of these hold:

- the ledger is empty, or has no place or nobody in it;
- the new prose exceeds 600 characters;
- any word-boundary match on a movement / time / arrival cue list;
- a capitalised word that is *not* opening a sentence and is not already on the
  roster.

Otherwise the ledger is **carried forward** — the row is rewritten at the new
position with the same values and `extraction_model = 'skipped'`, so the
position advances, the fingerprint re-anchors, and the skip rate is readable
straight off the ledger table.

Two implementation notes that are easy to get wrong and were:

- **Cues match on word boundaries.** A substring test looked fine and matched
  `lie` inside `believe` and `go` inside `ago`, so every quiet turn ran anyway.
- **Sentence-opening capitals are not names.** Roleplay prose opens sentences
  after `*` and `"` as well as after full stops; a naive capitalisation test
  flags the first word of nearly every message and skips nothing, ever. See
  `midSentenceNames`.

The heuristic is biased toward running: a false positive costs one very cheap
extraction, a false negative is a stale ledger the reader sees.

## 9 — Scene Ledger model

Default **Ling 3.0 Flash**, falling back to DeepSeek on a deployment with no
OpenRouter. Admin choices: Ling 3.0 Flash · Direct DeepSeek V4 Flash · the other
memory candidates · **Disabled**.

Failure handling: parse → normalise/bound → **one cheap retry on a malformed
reply only** (a transport failure is already retried across hosts by the
adapter) → otherwise retain the previous ledger. Disabled, skipped and failed
all end in the same place, which is what makes the feature safe to make cheap.
Scene Ledger failure can never break an RP reply: it runs after the reply is
delivered and never throws.

## 10 — Scene Ledger cache

Its own conversation-scoped session in the `scene_state` namespace, stable
instructions ahead of the previous ledger and the newest messages. Deliberately
not over-engineered: the savings come from **far fewer calls, a tiny prompt, and
a dirt-cheap model**, and cache is fourth of four.

## 11 — Measured results

### Scene Ledger, over one 40-turn synthetic story

`tests/scene-ledger-economics.test.ts` (offline, deterministic):

```
eligible story advances   34   (accepted replies and continues)
discarded drafts           6   (regenerations: never extracted, never charged)
extractor calls made       7
calls skipped             27
skip rate                 79% of eligible advances

fewer calls            40 → 7            (83% fewer)
smaller prompt         ~2,286 → ~969 input tokens per call
input tokens for story ~91,440 → ~6,786
```

with every genuine change still landing: the move to the kitchen, the hour that
passed, Anna arriving and leaving, and Anna staying on the ledger through
sixteen turns of nobody addressing her.

A cheaper model and a warm cache multiply that and are **not** counted there: a
price list is not a measurement and a cache ratio is a provider-reported number.

### Memory quality and live economics

**PENDING. No model credentials are available in this environment, so no paid
inference was run and no quality or cost claim about any candidate is made
here.**

The harness is built and the field is the admin selector's field, so a benchmark
of models nobody can select is impossible by construction:

```
MEMORY_EVAL=1 OPENROUTER_API_KEY=… ENABLE_OPENROUTER=true \
  npx vitest run tests/eval/memory-models.test.ts
```

It runs every *selectable* candidate over one window carrying four traps — a
promise genuinely kept, one explicitly not kept, one mentioned in passing, and a
fact contradicted and superseded — twice each so a second identical job can show
a cache hit. It reports per candidate: fresh input tokens, cached input tokens,
output tokens, cache ratio, provider cost, cost/update, projected cost/100
updates, latency, failure rate, and, scored separately, false promise
resolutions, supersession handling and boundary retention. Unverified host pins
are reported as not-run rather than attempted.

**One window is a smoke test, not a verdict.** Raise `MEMORY_EVAL_REPEATS` and
add windows before moving production. If in doubt, keep DeepSeek.

### Production cost reporting

`GET /api/usage/background` (admin, account-scoped) keeps the four mechanisms
apart rather than summing them:

- per `(task, route, decision)`: calls, fresh input tokens, cached input tokens,
  output tokens, cache ratio, provider cost, cost/update, projected cost/100,
  mean latency, and a `costBasis` of `provider_reported` / `mixed` /
  `estimated_only`.
- Scene Ledger: eligible turns, extractor calls, skipped, failed, skip rate,
  cost/update, and **cost per 100 accepted story advances** — the honest
  denominator, since per-call cost falls when a model gets cheaper while this
  falls when either the model or the call count does.

A null cache ratio means *the endpoint reported none*, never zero and never an
estimate. The offline prefix measurement is a ceiling; a ceiling is not a bill.

## 12 — Deployment

`supabase/migrations/0032_background_routing_and_scene_ledger.sql` — additive,
no back-fill, no data loss:

- `background_model_routes` (server-owned, RLS on, browser roles revoked)
- `conversations.memory_model_override`, `conversations.scene_model_override`
- `conversation_scene_states.present_people`, `.time_kind`

`ensureSchema()` applies the same changes for the test/dev path.

### Environment

| variable | effect |
|---|---|
| `BACKGROUND_ROUTE_VERIFIED_UPSTREAMS` | comma-separated upstream routing tags, suffix included, that an operator has opted this deployment into. Without it the two pinned 0731 candidates are listed, explained and refused. Set to `open-inference/fp8,relace/fp4` to enable both. |
| `MEMORY_CONSOLIDATION_MODEL_ROUTE` etc. | unchanged; now the fallback beneath the admin setting rather than the control. |

Nothing is required to deploy. With no settings row, no override and no
environment route, memory work runs on DeepSeek exactly as before, and the Scene
Ledger runs on Ling where OpenRouter is funded and on DeepSeek where it is not.

### Rollback

Set the global routes back, or unset them. The physical columns are still there
if the previous ledger is ever wanted back.
