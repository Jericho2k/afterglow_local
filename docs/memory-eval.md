# Memory V2.1a — the measurement gate

This is the instrument, not a fix. Nothing in it changes how the product
behaves; it exists to answer one question before a memory sprint is committed
to:

> When continuity breaks, is it because the fact never reached the writer, or
> because the writer had it and ignored it?

Those two answers imply completely different sprints, and until now the product
could not tell them apart. **Stop and read the numbers before building V2.1b.**

## The two-stage verdict

Every evaluated turn is judged twice, and the crossing is what produces an
attribution rather than an opinion.

| | reply clean | reply broke continuity |
|---|---|---|
| **fact was in the prompt** | pass | **B — writer misuse** |
| **fact was missing** | *latent* (passed, but the transcript was carrying it) | **A — retrieval / integrity** |
| **fact partly there** | latent | **C — ambiguous** |

Two deliberate refusals:

- **Contamination overrides everything.** If obsolete or resolved material was
  presented as authoritative, that is a retrieval fault regardless of what the
  reply did with it. (This rule was added *after* the first fixture run showed
  the original crossing blaming the writer for averaging two facts the ranker
  should never have shown it together.)
- **Ambiguous stays ambiguous.** Nothing is redistributed into A or B to make
  the answer look tidier. `decisionReadiness()` refuses to call a run steerable
  if more than 40% of failures are ambiguous, or if fewer than 20 failures were
  observed.

Code: `src/lib/eval/taxonomy.ts`, `src/lib/eval/evidence.ts`,
`src/lib/eval/report.ts`.

## Source A — deterministic fixtures (runs in CI, free)

```
npx vitest run tests/eval/continuity-cases.test.ts
```

Eight hand-authored adversarial situations pushed through the **real** ranker
(`hybridRankMemories`) and the **real** prompt builder (`roleplayPrompt`). No
inference, no API key, no network — so this runs on every push forever.

It answers stage one only: *was the prompt even given a chance to be right?*

Cases carry a **recorded** expectation, not an aspirational one. A case the
current implementation fails is marked `known_failure` with a note explaining
why. CI asserts `observed == recorded`, which means the suite goes red both
when something regresses **and** when a V2.1b fix makes a known failure start
passing — the second being exactly the signal a fix should produce.

Add a case in `tests/fixtures/continuity-cases.ts`.

## Source B — replayed real conversations (offline, opt-in)

Skipped unless pointed at a backup export, so CI never touches private data.

```bash
# 1. Export your data from Settings → Backup → Export JSON.
# 2. Stage one on real stories. No model calls at all:
EVAL_BACKUP=./afterglow-backup.json npx vitest run tests/eval/replay.test.ts

# 3. Add generation and judging to get the A/B/C split:
EVAL_BACKUP=./afterglow-backup.json \
EVAL_GENERATE=true EVAL_JUDGE=true \
npx vitest run tests/eval/replay.test.ts
```

| variable | default | meaning |
|---|---|---|
| `EVAL_BACKUP` | — | path to the backup JSON. Without it the suite skips. |
| `EVAL_LABELS` | — | hand-written expected facts per checkpoint. Beats derived facts. |
| `EVAL_GENERATE` | `false` | regenerate each checkpoint through the real writer |
| `EVAL_JUDGE` | `false` | audit those generations (requires a configured provider) |
| `EVAL_PROVIDER` / `EVAL_MODEL` | `deepseek` / `deepseek-v4-flash` | writer under test |
| `EVAL_CONVERSATIONS` | `5` | how many conversations to sample |
| `EVAL_CHECKPOINTS` | `8` | checkpoints per conversation |
| `EVAL_MIN_PRIOR` | `40` | skip turns earlier than this — early turns cannot fail |
| `EVAL_EVERY` | `12` | spacing between checkpoints |

### Three rules the replay obeys

1. **The original reply is not ground truth.** It came from the same system
   under evaluation, so scoring against it would mostly measure
   reproducibility. Checkpoints instead carry the continuity facts that were
   *established by that point*, and the judge is asked whether a fresh
   generation contradicts them.

2. **No checkpoint sees its own future.** `archiveAsOf()` filters memories and
   arcs by the `sourceMessageCount` / `endMessageCount` lineage stamps that
   consolidation already writes. An eval that leaks the future measures a
   system with foresight and reports numbers nobody can reproduce in
   production. This is asserted in CI.

3. **Nothing private leaves the harness.** It reads a local file, works
   offline, and the attribution record it emits carries identifiers, counts and
   verdicts — never transcripts, prompts or replies.

### Hand labels

Derived facts are a fallback; hand labels are better evidence. `EVAL_LABELS`
takes a JSON file keyed `conversationId:messageIndex`:

```json
{
  "cccccccc-0000-4000-8000-000000000001:96": {
    "facts": ["Maya moved permanently to Berlin", "Maya's brother is not speaking to her"],
    "obsolete": ["Maya lives in Prague"],
    "note": "the turn right after the move"
  }
}
```

## Source C — reader feedback (production, ongoing)

The only ground truth from somebody who actually knows. A **Wrong?** control on
every assistant reply records the category and links the
`memory_retrieval_runs` row that produced it, so one join turns a complaint into
the exact ranked list, the exact scores and the exact token allocations behind
it.

- Table: `memory_feedback` (migration `0018`), reader-private under RLS — not
  even the creation's author can enumerate labels on their own creation, because
  a label implies what was in a private story.
- API: `POST /api/memory-feedback`, `DELETE /api/memory-feedback?messageId=…`
- The reader-facing wording maps 1:1 onto the taxonomy:

| reader sees | category |
|---|---|
| She forgot something | `forgot_something` |
| It contradicted itself | `contradicted_itself` |
| It brought back something finished | `brought_back_finished` |
| Wrong place or time | `wrong_place_or_time` |
| Confused who was there | `confused_who_is_present` |

Let this accumulate. It will be worth more than both synthetic sources
combined, and it costs nothing per label.

## Reading the output

```
attribution of failures
  A retrieval / integrity     31   62.0%
  B writer misuse             14   28.0%
  C mixed / ambiguous          5   10.0%
```

Then `decisionReadiness()` prints whether the sample can steer a sprint:

- **A dominates** → V2.1b (commitment lifecycle, protected budget,
  contradiction) is justified.
- **B dominates** → fix the writer contract first. The prompt hands the model a
  flat bulleted list of memories with one line of guidance on how to use them;
  that is a day of work, not a sprint, and no amount of ranker tuning will
  substitute for it.
- **Within 15 points of each other** → no clear winner. Do the cheap safe fixes
  first (staleness decay, protected ceiling) and re-measure.

## What this gate has already found

Running it produced two results before a single line of memory code changed:

1. **The protected-crowding hypothesis is refuted.** Memory V2 dropped the 55%
   protected-tier ceiling V1 had, and the concern was that commitments could
   crowd out the memory a turn is about. Swept from 120 to 3000 characters at
   the default 3600-token episodic budget, the relevant memory survived every
   time — `hybridRankMemories` checks the budget *per item*, so the protected
   tier simply shrinks (12 entries → 8 → 4) and leaves room. The missing ceiling
   is a latent risk, not a live defect. **Priority downgraded.**

2. **Obsolete facts are injected beside their replacements.** "Maya lives in
   Prague" and "Maya moved permanently to Berlin" are both retrieved, both
   presented as current, with nothing marking which one won. Jaccard dedup at
   0.72 catches paraphrases, not contradictions. This is the one recorded
   `known_failure`, and it is the case for the supersession work.
