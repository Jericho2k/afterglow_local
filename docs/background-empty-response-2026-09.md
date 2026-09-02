# The background jobs that failed silently, and why nobody knew

A production hotfix. Read alongside `background-inference-2026-09.md`, which
describes the routing and cost work this is a correction to.

**The report that started it:** a reader chatted normally and discovered *later*
that the conversation had **0 memories**. Background work is deliberately not
coupled to the reply, so the chat request was correct and cheerful throughout.
Every failure had been written to a console nobody was watching.

That last sentence is the actual defect. The request bugs below are ordinary —
two wrong capability declarations and a missing parameter; a product that cannot
tell you its memory has stopped working is not.

**Second pass.** Ling kept failing after the first fix, and the diagnostics this
document added said why: it is a reasoning model that was declared as not one.
A second defect surfaced at the same time — every write to the new health table
was refused by row level security, so the visibility built to answer all of this
was itself invisible. Both are covered below (causes C and §4c).

---

## 1 — Confirmed causes

### A. Ling 3.0 Flash was sent a parameter it does not implement — CONFIRMED

`ling-3.0-flash` declared `jsonMode: true`. The OpenRouter adapter turned
`json: true` into `response_format: {type:"json_object"}` **unconditionally**,
for every model. OpenRouter documents Ling 3.0 Flash as not supporting
`response_format`.

Confirmed by reading, not by inference: the capability was wrong in the
catalogue, and the adapter had no code path that consulted it. Every Scene
Ledger extraction on Ling sent the parameter. The observed result was a run of
`ProviderError category=empty_response`.

### B. `429 engine_overloaded` from DeepInfra — NOT A BUG

One Ling failure was ordinary upstream capacity. Nothing to fix in the request.
It is evidence for cause E: a routine 429 on a background job was equally
invisible.

### C. Ling is a reasoning model, and the catalogue said it was not — CONFIRMED IN PRODUCTION

The `response_format` fix in §A was correct and incomplete. Ling kept failing,
and the diagnostics added in §4 said exactly why:

```
model inclusionai/ling-3.0-flash · upstream Novita · max_tokens 400
finish_reason "length" · content null
completion_tokens ~400 · reasoning_tokens ~400+
hasReasoning true · hasReasoningDetails true · requestedReasoningOff FALSE
```

Ling 3.0 Flash is a **hybrid reasoning model with thinking enabled by default**.
The catalogue declared `thinking: false`, which every caller read as *"this
endpoint does not accept a `reasoning` parameter"* — so none was ever sent. And
never sending one is not declining: it takes the endpoint's own default.

`requestedReasoningOff: false` is the tell, and it is why that field exists.

### D. DeepSeek V4 Flash 0731 was never told not to reason — CONFIRMED AS A DEFECT, HYPOTHESISED AS THE CAUSE

Two things are certain from the code:

- Background calls passed no `thinking` option, so `commonFields` emitted **no
  `reasoning` key at all**. Omitting it is not "off" — it takes the endpoint's
  own default, and 0731 is reasoning-capable (`thinking: true`).
- `src/lib/deepseek.ts` has always sent `thinking: {type:"disabled"}` on its
  non-streaming path. **Direct DeepSeek never had this problem and the
  OpenRouter route was doing the opposite thing for the same job.**

Reasoning tokens are billed and counted as *completion* tokens, so they come out
of the same `max_tokens: 3600` as the JSON. A model that reasons before it
answers can spend the envelope and return `content: null` with the text in
`message.reasoning`.

**What is not confirmed:** that this is what 0731 actually did. No credentials
exist in this environment, so nothing was reproduced against the live host. The
adapter now captures the evidence that settles it — see §4 — and the fix is
correct on its own terms regardless of which way that lands: a background
extraction has no use for hidden thinking, and the two providers should not
disagree about it.

### E. The failures were invisible — CONFIRMED, AND THE REAL DEFECT

`usage_events` cannot answer "is memory being written". A row exists when a
model ran and reported tokens; a run of empty responses, a run of 429s and a
route that was never selectable all leave the same trace there — none. Absence
of work is indistinguishable from absence of evidence.

---

## 2 — Ling wire request, before and after

```diff
  {
    "model": "inclusionai/ling-3.0-flash",
    "messages": [ …"Output JSON only"… ],
    "max_tokens": 400,
    "temperature": 0.1,
-   "response_format": { "type": "json_object" },
    "usage": { "include": true },
    "session_id": "…"
  }
```

That was the first pass, and it was not enough on its own: the same route kept
failing for the *second* reason in cause C, and a `reasoning: { enabled: false }`
now travels with it. **See §4b for the complete Ling request.**

**What did not change:** the prompt still asks for JSON in words, the reply is
still parsed and bounded by `normalizeSceneUpdate`, and the Scene Ledger's
existing one-retry-on-malformed-output path is unchanged. Losing the parameter
must not become losing the requirement.

`supportsStructuredOutput(providerId, modelId)` is the new gate. A model with no
catalogue entry still gets `response_format`, which is byte-for-byte the
behaviour before this existed — only a model whose entry says otherwise loses
it.

## 3 — 0731 wire request, before and after

```diff
  {
    "model": "deepseek/deepseek-v4-flash-0731",
    "messages": [ …consolidation rules, then the window… ],
    "max_tokens": 3600,
    "temperature": 0.2,
    "response_format": { "type": "json_object" },   // kept: 0731 supports it
+   "reasoning": { "enabled": false },
    "usage": { "include": true },
    "session_id": "…",
    "provider": { "only": ["relace/fp4"], "allow_fallbacks": false, … }
  }
```

`backgroundReasoningFor(modelId)` decides, and has three answers: `undefined`
where the endpoint does not accept the parameter, `"off"` where reasoning is
supported and optional, and an effort level where an endpoint declares reasoning
**mandatory** (`{enabled:false}` would be refused there, so the least it will
agree to is the nearest expressible version of the intention).

It is deliberately **not** `defaultReasoningFor`, which serves the RP writer and
is steered by `RP_REASONING`. Background extraction is not roleplay and must not
move when that switch does. **Writer reasoning is untouched** — asserted in
`tests/background-request-shape.test.ts`.

### The negotiation a background job refuses

The adapter's one adaptation — told `reasoning` cannot be disabled, drop the key
and retry — is right for a roleplay turn and wrong here: it hands back the
endpoint's own default, which is *more* thinking in the same small envelope,
reproducing the failure one attempt later at the same cost.

Background calls now send `strictReasoning: true`. A pinned host that refuses
reasoning-disabled fails as `bad_request` with the endpoint's own words in the
diagnostic, is logged as **incompatible with background extraction**, and — per
§5 — is *not* silently rescued, because that is a configuration fact somebody
needs to see.

## 4 — What the failing 0731 response shape will imply

The adapter used to throw `empty_response` carrying a request id and discard the
entire body. It now captures, before throwing:

| field | why |
|---|---|
| `contentState` | `null` / `missing` / `empty_string` / `non_string` — four different bugs |
| `finishReason`, `nativeFinishReason` | did the model stop, or run out |
| `promptTokens`, `completionTokens`, `reasoningTokens` | where the envelope went |
| `hasReasoning`, `hasReasoningDetails` | **presence only** |
| `requestedReasoningOff` | what we asked for, beside what we got |
| `choices` | zero choices is a different failure from an empty one |
| `upstreamProvider`, `actualModel`, `requestId` | which host, which revision |

**Every field is a number, a boolean or an enum.** The answer to "why was this
empty" frequently lives inside a model's reasoning text, which is derived from a
reader's private transcript and is the last thing that may reach a log. A
boolean carries the diagnostic signal completely.

Reading the result:

- `finish_reason: "length"` + reasoning tokens + no content → **the envelope was
  spent on thinking.** Now classified as `reasoning_budget_exhausted` rather
  than `empty_response`: different cause, different remedy, and retrying it
  unchanged reproduces it exactly and bills for the reasoning again. If this is
  what the logs show, cause C is confirmed and the fix already applied is the
  fix.
- `finish_reason: "stop"` + zero completion tokens + no reasoning → **a silent
  host.** Still `empty_response`; the remedy is routing, not budget.
- `choices: 0`, or `contentState: "non_string"` → a response shape nobody
  expected. That would be a genuinely new finding.

One more correction while here: `"\n"` is a string, so a whitespace-only reply
used to pass the type check and fail at `JSON.parse` two layers away, reported
as a different failure than the one that happened. Whitespace now counts as
empty.

## 4b — Ling: the wire request, before and after

```diff
  {
    "model": "inclusionai/ling-3.0-flash",
    "messages": [ …"Output JSON only"… ],
    "max_tokens": 400,
+   "reasoning": { "enabled": false },
    "usage": { "include": true },
    "session_id": "…"
  }
```

No `response_format` before or after — that half was already right.

**The envelope is deliberately NOT raised.** A ledger update is a handful of
JSON fields; paying hundreds of reasoning tokens to produce them is the cost
this whole layer exists to avoid, and a bigger `max_tokens` would have bought
the symptom's disappearance rather than the fix. Asserted:
`expect(bodies[0].max_tokens).toBe(400)`.

### The mechanism, and how to check it against a live host

`reasoning: { enabled: false }` is OpenRouter's normalised form, already used
everywhere else in this codebase, rather than any host's native spelling.

*OpenRouter accepts the parameter* and *the upstream host obeys it* are
different claims, and Ling is served by several hosts (Novita, DeepInfra). No
credentials exist in this environment, so the second claim is **not verified
here**. `scripts/reasoning-off-verify.mjs` settles it for about a hundredth of a
cent:

```
OPENROUTER_API_KEY=… node scripts/reasoning-off-verify.mjs --providers novita,deepinfra
```

It sends one tiny fixed prompt per host twice — once with reasoning off, once
with no key — and prints the token split. Zero reasoning tokens with content
present means the host honours it. Reasoning tokens with the parameter accepted
means the route is unsuitable for tiny structured jobs and should be said so
rather than papered over. A 400 about reasoning means the endpoint mandates it
and the model should declare `reasoningMandatory: true`. Nothing it prints can
contain a prompt or a model's output.

### Writer semantics

Unchanged, and asserted. `defaultReasoningFor` reads `capabilities.
reasoningDefault`, which Ling still does not declare, so a roleplay turn on Ling
sends **no `reasoning` key** exactly as before.

Two things the corrected capability does unlock for the writer, both strictly
better and neither a change of default:

- the "Complex & Strategic" engine, which asks for thinking, can now say so
  instead of being silently dropped — and silence took the endpoint's default,
  which was thinking anyway;
- `canDeclineReasoning` becomes true, so the chat route's empty-reply retry can
  ask for no reasoning rather than only enlarging the envelope. That is the
  correct remedy for exactly the failure Ling produces.

**Open, and deliberately not changed here:** if Ling reasons by default, RP
turns on it are also spending part of their reply envelope on thinking. Setting
`reasoningDefault: "off"` would stop that, and it is a writer-quality decision
with its own evidence, not a hotfix.

## 4c — `background_job_health` RLS: reproduced, then repaired

```
[background-health] could not record a success
new row violates row-level security policy for table "background_job_health"
code 42501
```

**Reproduced against a real PostgreSQL**, with the shipped migrations and the
exact session `asUser()` opens — `BEGIN; SET LOCAL ROLE authenticated;
set_config('request.jwt.claims', …)`. Three reachable schema states, three
different answers:

| state | result |
|---|---|
| A · table created, RLS off, no grant | `permission denied for table` |
| B · table created, RLS **on**, granted, **no policy** | `new row violates row-level security policy` ← **production** |
| C · migration 0033 applied in full | **INSERT OK** |

So `auth.uid()` was never the problem — inside that transaction it evaluates to
the account id correctly, and state C proves the 0033 policy works as written.
Production was in **state B**.

**How a database reaches state B.** `ensureSchema()` creates this table on every
boot, because Afterglow must be able to stand up a plain PostgreSQL.
`supabase/migrations` is applied **by hand** (see README). A deploy therefore
creates the table before anybody runs 0033 — and on a Supabase project, where a
new public table inherits grants to `authenticated` and is protected as an
exposed table, that lands exactly on *guarded, granted, and no policy*: every
write refused, the server's own included.

**Why no test caught it.** pg-mem implements neither roles nor policies, so the
suites covering this table's *behaviour* could not see its *access*. And the
real-PostgreSQL suite never applied migrations 0032–0034, because
`migrationFiles` is a named list and nobody added them. Both are fixed: the
files are registered, and `tests/background-health-rls.test.ts` runs the
production statements under the real policies.

**The repair.** `0034_background_job_health_policy_repair.sql` — additive,
idempotent, safe to apply twice, and it **adds a policy rather than removing a
guard**. RLS stays enabled, FORCE stays on, no service-role bypass is
introduced, and background code still uses user-scoped SQL. Applying it to a
database that already has 0033 is a no-op re-assertion.

**And the structural fix.** `ensureSchema()` now creates the protection *with*
the table — RLS, FORCE, the policy, the grants, and a REVOKE from `anon` —
guarded exactly like the `afterglow_runtime_migrations` block beside it, so the
in-memory test database is allowed to refuse it. The migration remains the
authority; this closes the window between a deploy and an operator, and makes
the dangerous half-state unreachable rather than merely documented.

## 5 — Memory fallback policy

**Long-term memory only, one attempt, and only for failures that are about a
route rather than about a misconfiguration.**

When memory consolidation on a **non-control** route fails recoverably, the same
window is retried once on Direct DeepSeek V4 Flash.

| category | fallback | why |
|---|---|---|
| `empty_response` | ✅ | the failure that started this |
| `reasoning_budget_exhausted` | ✅ | same family |
| `rate_limited` | ✅ | one host, one afternoon |
| `upstream_unavailable` | ✅ | same |
| `malformed_output` | ✅ | paid for, and not the contract |
| `no_summary` | ✅ | answered without the one required field |
| `auth` / `billing` | ❌ | routing around it means finding out at the worst moment, not the first |
| `bad_request` | ❌ | our catalogue is wrong, or a pinned host refuses this job — the signal that says which |
| `content_filtered` | ❌ | a refusal is a decision; re-asking a different model is routing around a safety layer |
| `timeout` | ❌ | a second full consolidation on top of one that already ran long, with nobody waiting |

**Why memory gets a fallback at all:** the loss is permanent. Once the story
moves on, the window a failed job did not read is consolidated-past and no later
job goes back for it. An experiment allowed to be wrong about cost is fine; one
that silently deletes continuity is not.

**No same-model retry first.** A consolidation is the most expensive background
call there is, and a model that has just produced malformed JSON is the least
likely thing to produce valid JSON on an identical second ask. One extra attempt
is the budget, and spending it on the control is strictly better.

**Not for the Scene Ledger.** Its previous state simply stands, which is a
correct answer, and it already treats a skip, a failure and a disabled extractor
as one behaviour with three causes.

**Not for canon curation.** Watched, not rescued — the difference is what is
lost. A failed curation loses nothing: the memories and arcs it reads are all
still there, and the next interval tries again.

**Not for writer generations.** Unchanged.

### Provenance

`provider_metadata.routing` gains `fallback: true`, `requestedCandidate` and
`failureReason`. Without them a fallback is indistinguishable from a deliberate
switch to DeepSeek, and an A/B period would credit the control with the
challenger's traffic — the one way to make the comparison say the opposite of
what happened. Both attempts are billed when both produced tokens.

**The health row names the rescued attempt too.** Production showed
`deepseek_0731_relace` failing `malformed_output` and Direct DeepSeek succeeding
— correct behaviour, and it read in the drawer as a perfectly healthy job on
DeepSeek, with the candidate under evaluation never once named as the thing that
keeps failing. A successful fallback now writes `last_failure_*` alongside
`last_success_*` and keeps `consecutive_failures` at zero, so one row says both
"memory is being written" and "by the control, because Relace keeps producing
malformed JSON". No extra retries were added: it is still one attempt, then the
control.

## 6 — Operator visibility

New table `background_job_health`, per (conversation, task): last success
at/model/candidate, last failure at/model/candidate/**category**, consecutive
failure count, and whether the last success was the control rescuing the route.
Reset to zero on any success; the last failure is kept even after recovery.

Surfaced in the **Memory drawer**, in `BackgroundModelPanel` — the same panel
that chooses the model, because "which model" and "is it working" get asked in
one breath.

`memoryWarning()` produces one sentence or none:

- ≥3 consecutive failures → *"Memory extraction has failed 4 times in a row
  (empty_response). This story is not gaining new memories."*
- ≥1 failure → *"The last memory extraction failed…"*
- **the silent case** → *"60 messages have not been consolidated yet. Memory
  extraction may not be running for this story."* — this is the one that catches
  the original report, where nothing was recorded because nothing was reaching a
  model.
- healthy → **null.** A panel that always shows a warning is a panel nobody
  reads.

Never a prompt, never a body, never a secret: `last_failure_reason` is a
category, bounded to 60 characters by a CHECK constraint. Scene Ledger keeps its
own last-extraction-failure line, unchanged.

## 7 — Cost work preserved

Asserted, not assumed:

- memory stable-prefix layout — `tests/memory-cacheability.test.ts` unchanged
- `memory_consolidation` session affinity — `session_id` still sent, asserted on
  the wire
- pinned routes, exact tags `open-inference/fp8` / `relace/fp4`,
  `provider.only` + `allow_fallbacks: false` — asserted on the wire
- provider-reported cache/cost accounting — unchanged
- Scene Ledger skip heuristic, and Regenerate never running it — unchanged

## 8 — Tests

`tests/background-request-shape.test.ts` (13) — mocks `fetch` and reads the body
actually sent: Ling never receives `response_format`; Ling's prompt-only JSON
still parses; **Ling is marked reasoning-capable and its Scene Ledger request
sends `reasoning:{enabled:false}` while `max_tokens` stays 400**; 0731 receives
`response_format` and `reasoning:{enabled:false}`; pinned routing/session/usage
fields intact; a host refusing reasoning-disabled fails once rather than
retrying without it; Direct DeepSeek still sends `thinking:{type:"disabled"}`;
writer reasoning unchanged in all four states **and unchanged for Ling
specifically**.

`tests/empty-response-diagnostics.test.ts` (8) — host/finish/token capture; the
`reasoning_budget_exhausted` split; four content states; zero choices;
whitespace; and two tests that no reasoning text, content or prompt reaches the
diagnostic or the log.

`tests/memory-fallback.test.ts` (17) — rescue, provenance, both attempts billed,
no fallback on success, no control→control, one attempt not a cascade, window
left unconsolidated when both fail, no fallback on
auth/billing/bad_request/content_filtered, Scene Ledger never rescued, health
recording, category-only storage, curation watched-not-rescued, the three
warning states, **the Relace `malformed_output` case naming the candidate it
rescued**, and no invented rescue on an ordinary success.

`tests/background-health-rls.test.ts` (10) — **real PostgreSQL**, real migration
files, and the exact `asUser()` session. Owner can insert, update in place, and
read back; another account can do none of those; FORCE stays on and exactly one
policy exists; `anon` gets nothing. Then the half-created state: it **reproduces
the production error verbatim**, shows 0034 repairing it without disabling
anything, and shows 0034 being safe to apply twice.

Plus the operator-visible payload in `tests/api-authorization.test.ts`, and
migrations 0032–0034 registered in `migrationFiles` so the pre-existing tenancy
suites apply them too.

**1770 passed, 145 skipped offline** (was 1765); **98 passed** against real
PostgreSQL. Lint clean, `tsc --noEmit` clean, build compiles.

## 9 — Deployment

`supabase/migrations/0033_background_job_health.sql` — one new table, RLS
enabled and forced, owner policy, `authenticated` grants. Additive; nothing
back-filled; a story with no row simply shows no health line.

`supabase/migrations/0034_background_job_health_policy_repair.sql` — **must be
applied**, and is the whole of the RLS fix for a database already in state B.
Additive, idempotent, safe to run twice.

**No environment variable changes.** Nothing to set, nothing to unset.

The Ling capability correction takes effect on deploy with no action. If Scene
Ledger is currently selected on Ling, it starts working; if memory consolidation
is on an experimental route, it starts falling back to the control instead of
silently producing nothing.
