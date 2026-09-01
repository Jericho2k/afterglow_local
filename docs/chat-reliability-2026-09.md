# Chat reliability, regeneration, stream completion and the mobile hotfix

What was actually wrong, how each answer was established, and what is still an
open question that only a live paid provider can close.

The sprint report is organised by the two production symptoms that mattered
most — Regenerate failing where Send and Continue did not, and replies ending
mid-sentence — followed by the mobile layout and navigation regressions.

---

## 0. What is established, and what is not

This distinction runs through the whole report and is worth stating once at the
top, because the temptation with an asymmetric production failure is to find a
real defect and then narrate it as *the* cause.

**Confirmed offline.** Every item below is a defect reproduced in a test, fixed,
and re-asserted:

| | Kind |
|---|---|
| Regenerate's transcript window began one message earlier than the equivalent Send | cost and latency regression (cache miss) |
| Regenerating a reply that follows a reply built a request ending on an assistant turn, or on a system block | request-shape correctness |
| The regeneration target was resolved as "newest row", ignoring the id the browser sent | correctness — wrong reply rewritten, or an id collision |
| The variant index was allocated before the model ran | correctness — lost text, and provenance silently not written |
| A stored variant could survive a failed provenance write | correctness — provenance invariant |
| The stream parser discarded an unterminated final frame | correctness — lost text |
| A stream that died mid-reply was reported as a completion | correctness — silent truncation |
| `defaultReasoningFor` was dead code | reasoning ran where the catalogue said it must not |
| The chat header and cast cards were wider than the phone | layout, measured in a browser |
| Back re-opened a chat that was already open | navigation |

**NOT established.** The production failure category itself. Nothing in this
sprint reached a paid provider, so no claim is made about *which* of the above —
if any — produced the reported "Something went wrong while generating the
response", nor about what GLM 5.3 Flash was actually returning.

In particular, the cache-miss defect is **not** advanced as a refusal mechanism.
`max_price` filters endpoints on their list pricing; a prompt that bills more
because it missed a cache does not thereby exceed that ceiling. It cost money
and time. Whether it cost availability is unknown.

§1.5 lists the open questions and the commands that close them.

---

## 1. Regenerate

### 1.1 What was different about Regenerate

Four things, of which three were invisible from the outside. None of them is a
provider outage, which is what the asymmetry in the report already implied: Send
and Continue worked on the same conversations, on the same models, minutes apart.

**A. Regenerate was the only action that could never hit a prompt cache.**
*(Confirmed: cost and latency. Not a refusal mechanism — see §0.)*

The transcript window is *anchored*: its start is quantised against the
conversation's absolute message count so that the first token of the request
stops moving every turn, which is the entire basis of the provider prompt
caching that the GLM routing work is built on (`selectAnchoredMessages`,
`src/lib/context.ts`).

Regenerate excludes its target from the rows it draws the window from — it must,
the reply is being replaced — but `knownMessageCount` still counted it. The
anchor arithmetic was therefore off by one for exactly this action, and the
window began **one message earlier** than the Send that produced the same reply.

Measured on a 241-message conversation, before the fix:

```
send        36 messages, window starts at "assistant turn 183"
regenerate  37 messages, window starts at "user turn 183"     ← different prefix
```

A different first token is a total cache miss, so every regeneration paid full
fresh-input rates for a prompt the send beside it had cached, and waited for it.

**What that is, and what it is not.** It is a confirmed cost and latency
regression, measured above and asserted in
`tests/regenerate-reliability.test.ts`. It is **not** a mechanism by which a
provider would refuse the request, and this report does not claim one:
`max_price` filters endpoints on their **list pricing**, so a larger fresh-input
bill cannot push an otherwise valid request through that ceiling. Whether
routing policy was refusing anything in production is a separate, still-open
question — §1.5.

After the fix the two windows are byte-identical up to the continuity block.

**B. Regenerating a reply that follows another reply produced a malformed
request.**
*(Confirmed: request-shape correctness.)*

With tail continuity placement (every caching model), `writerMessages` inserted
the changing half of the prompt "before the last message". When the transcript
ends on an assistant turn — which is what regenerating a Continue-produced reply
leaves behind, and what any story whose newest turn is not the reader's looks
like — the result was:

```
[system, assistant, user, system, assistant]
```

A system message wedged between the reader's turn and the model's own, and a
request whose final message is an assistant turn. A chat API given a trailing
assistant turn is being asked to **extend** it — several upstreams treat it as a
prefill — so the "regeneration" comes back as a continuation of a message the
reader has already accepted.

Two changes, because moving the continuity block alone only got halfway. It now
goes before the last **user** message when there is one and after the whole
transcript when there is not, which satisfies the rule the placement exists for
(nothing after the reader's own words) in both cases — but that leaves a request
whose final message is a system block, which is well formed and merely odd: the
last thing the writer reads is background rather than a turn.

So a regeneration whose transcript ends on an assistant turn now gets an
explicit `[REGENERATE]` **user** control turn (`regenerateSceneCue`), and the
request ends where a chat API expects a generation to be triggered from. The cue
says what is being asked for, says that every message above it is accepted and
must not be rewritten, and says never to mention itself. It deliberately does
**not** quote the reply being replaced — Continue quotes its anchor because it
must resume from those exact words, while Regenerate is asking for an
*alternative* to them, and showing the writer that reply is how a regeneration
comes back as a paraphrase of the attempt it was meant to replace.

Ordinary regenerate-after-a-user-turn is untouched and gets no cue: the reader's
own message is already a complete request.

The two shapes are asserted by exact role order in
`tests/regenerate-reliability.test.ts`:

```
user → assistant(target) → regenerate
  system, assistant, system, user                       ← the reader's own turn

user → assistant → assistant(target from Continue) → regenerate
  system, assistant, user, assistant, system, user      ← the control turn
```

**C. Regenerate resolved its target by "whatever row is newest", ignoring the
id the browser sent.**
*(Confirmed: correctness.)*

`assistantMessageId` was read only as a fallback id for an INSERT. So when the
newest row was not the reply the reader was looking at, a *different* reply was
rewritten; and when the newest row was a user turn, the target silently became
`null` and the "regeneration" inserted a brand-new message under a
client-guessed id, which collides with a real row as often as not and surfaced
as *"That reply could not be saved."*

Now: a regeneration may only target the newest message, that message must be an
assistant turn, and the three cases are distinguished
(`src/lib/regeneration.ts`) — the browser's id matches (normal), it names a real
row that is no longer newest (refused, with a sentence saying the story moved
on), or it names nothing in the database (a stale optimistic id from a reply
whose write failed, which falls back to the newest reply as before).

**D. The variant index was allocated before the model ran.**
*(Confirmed: correctness.)*

`variants.length` was read at the start of the turn and used tens of seconds
later. Two regenerations of one reply therefore both claimed the same index: the
later `UPDATE` dropped the earlier's text, and the later
`INSERT … ON CONFLICT DO NOTHING` on `(message_id, variant_index)` wrote
**nothing at all** while reporting success — so a real generation existed with no
provenance, and the Context inspector reported "not recorded" for a reply
produced a second earlier.

The allocation is now inside one locked transaction that also writes the message
and its provenance (`commitRegeneratedVariant`).

**And a provenance failure abandons the variant.** Reporting the conflict as a
flag the caller logged was not enough: it still left a stored reply whose
`message_generations` row belongs to a *different* generation, which makes the
Context inspector confidently wrong about what that reply was written from —
precisely the state the table exists to prevent. `recordGeneration` returning
false now throws `ProvenanceConflictError`, which rolls the transaction back with
the message `UPDATE` inside it. The reader is told the reply could not be saved,
which is true, and the row is left exactly as it was.

`VariantCommit` no longer carries an unreachable `variant_conflict` arm or a
`provenanceRecorded` flag nobody could act on; the conflict is an error with a
name. `commitNewAssistantMessage` holds the same invariant for variant 0. Both
are asserted by provoking a real conflict and checking the row is untouched
afterwards.

### 1.2 Why Send and Continue were fine

Send and Continue both create a *new* assistant message. They never exclude a
row from the window (so the anchor is right), never end the transcript on an
assistant turn (Send ends on the reader's message, Continue appends a user-role
cue), never resolve a target, and always write variant 0 of a row that did not
exist a moment ago. Every one of the four defects above is reachable only
through the regenerate branch.

### 1.3 Reasoning, and the model the operator is testing

`defaultReasoningFor` was added with the model expansion and **was called by
nothing**. GLM 5.3 Flash's `reasoningDefault: "off"` — added precisely because
that model reasons before it speaks, with an independently measured
time-to-first-token in the tens of seconds — therefore had no effect on any
request. Omitting the `reasoning` parameter is not declining reasoning; it is
declining to have an opinion, and a hybrid reasoning model's own opinion is to
reason.

The chat route now consults it. Precedence is unchanged: an engine that wants
reasoning still gets it, `RP_REASONING=off` is still the deployment-wide
override, and a model that declares no default still sends nothing.

### 1.4 Provider-specific 400s

`bad_request` remains non-retryable — a malformed request is a bug, and asking
three times does not fix a bug. What changed is one narrow case: a 400/422/404
that was **relayed from an upstream** (the body carries `provider_name`, or a
"Provider X returned error" line) **and** reads as a capability or parameter
complaint is now retried against a different host for the same model, with the
refusing host excluded by name. See `providerSpecificRejection` in
`src/lib/provider-errors.ts` and its tests. A relayed refusal that is not about
parameters — a content-policy refusal, a malformed message array — is as
non-retryable as it was.

### 1.5 What is still open

Nothing in this sprint could reach a paid provider: this environment's egress
policy denies `openrouter.ai`, and no key was available. So the following remain
**unverified against live traffic**:

- Which of A–D was responsible for what share of the production failures.
- The actual error categories GLM 5.3 Flash returns. The report's description
  ("Something went wrong…") maps to `auth`, `billing`, `bad_request` or
  `unknown`, and the new per-turn diagnostic is what will say which.
- Whether any of the five routing constraints excludes every endpoint serving
  `z-ai/glm-5.3-flash`. `scripts/provider-constraint-bisect.mjs` adds them one at
  a time and names the first that fails; its mirror of the catalogue is pinned by
  a test so it cannot measure a policy nobody ships.

**To close them, with a key:**

```
CHAT_GENERATION_DIAGNOSTICS=1                      # one line per turn, in production
node scripts/provider-constraint-bisect.mjs --models glm-5.3-flash,glm-5.3-flash-economy --stream
grep '\[generation\] rp turn failed' … | grep '"action":"regenerate"'
```

---

## 2. Replies ending mid-sentence

### 2.1 The parser dropped its last line

The stream was parsed inline in the chat route, and the loop kept the final
element of `buffer.split("\n")` as the incomplete remainder — correct while a
stream is flowing and wrong at the end of one. A stream whose final `data:`
frame arrives **without a trailing newline** — a connection that closes on the
last write, a proxy that drops the terminator — left that frame in the buffer,
unparsed, forever. If it carried the closing sentence of a reply, the reply
stopped mid-thought and nothing anywhere recorded an error.

Parsing now lives in `src/lib/stream-parse.ts` with `end()` flushing both the
`TextDecoder` and the buffered final line. `tests/stream-parse.test.ts` runs the
same bytes split at **every** boundary from one byte upward, plus: a final delta
in the last packet with no terminator, `[DONE]` with no terminator, a usage-only
frame in the middle of the text, usage after the final text, `finish_reason` on
its own frame, CRLF, `data:` with no space, SSE comments, a non-streamed
`message.content` body, and multi-byte characters split across chunks.

### 2.2 A stream that stopped was reported as a generation that finished

The dropped-final-frame fix removed one silent truncation. It did not remove the
other, which leaves no trace at all: prose arrives, the transport dies, and there
is no `finish_reason`, no `native_finish_reason` and no `[DONE]`. With nothing
distinguishing that from a generation that ended on purpose, it was stored,
announced and logged as an ordinary success — a sentence stopping halfway with
no explanation anywhere.

So "the stream ended" and "the generation completed" are now separate questions.
`streamEnding` claims a completion only on **terminal evidence** — something in
the protocol stating the generation is over:

| Ending | Condition |
|---|---|
| `complete` | `finish_reason`, or `native_finish_reason`, or `[DONE]` |
| `empty` | no prose at all — the existing retry path's question |
| `interrupted` (`transport`) | prose, and none of the above |
| `interrupted` (`upstream_error`) | prose, and an error frame after it |

What follows from an interruption is deliberately narrow:

- **The text is kept.** Every byte arrived, was produced, and was billed.
  Discarding it loses the reader's scene and changes nothing about the cost.
- **Nothing is generated to cover it.** No second model turn on a guess.
- **It is not called a success.** The completion event carries
  `incomplete: true` and `interruptedBy`; the client keeps the prose and says
  the reply was cut short, pointing at Continue, which is already the control
  for picking it up.
- **The diagnostic says which.** `reason: "incomplete_transport"`, outcome
  `failed`, with the cause in `detail`.
- **Accounting stays accurate.** Usage is recorded and the free-tier slot is
  spent, because the tokens really happened. Route health records the turn as
  *not* successful — averaging an interrupted generation's latency in would make
  a route that cuts replies off look healthy.

A reply that stopped at `finish_reason: "length"` is **complete and truncated**,
which is a different fact: the generation ended, deliberately, at a limit we set.
Both are reported, and neither triggers a continuation on its own.

`tests/stream-parse.test.ts` covers every ending shape — text with a finish
reason and `[DONE]`; a finish reason and no `[DONE]`; `[DONE]` and no finish
reason; a native finish reason alone; abrupt EOF with neither; an unterminated
final frame that *carries* the evidence; length truncation; and an error after
partial text — each at every byte boundary. `tests/regenerate-reliability.test.ts`
carries the same cases end to end through the route.

### 2.3 Nothing recorded how a generation ended

`finish_reason` was read only to tell an empty reply from a filtered one, so a
reply that *was* produced and *was* cut off at the output ceiling was
indistinguishable from one that finished. Those have opposite fixes.

The parser now captures `finish_reason` and `native_finish_reason`, whether
`[DONE]` arrived, whether a usage frame arrived, and how many frames it could not
read. The turn's diagnostic records all of them plus `truncated`,
`completionTokens` and `reasoningTokens`, and the completion event carries
`truncated: true` to the client.

### 2.4 The output envelope

Unchanged, deliberately. The measured cause available offline is §1.3: reasoning
tokens are spent from the **same** envelope as the prose, so a hybrid reasoning
model asked for the endpoint's default could spend most of a Natural reply's
1,800 tokens thinking and then be cut off at `finish_reason: "length"`. Raising
the ceiling before that is fixed would have paid for the same reasoning twice.

The envelopes today, from `responseLengthBudget` with the 1,800-token baseline:

| Profile  | Scale | `max_tokens` | Directive asks for |
|----------|-------|--------------|--------------------|
| Concise  | 0.33  | 594          | 90–170 words       |
| Natural  | 1.0   | 1800         | (no target)        |
| Detailed | 1.6   | 2880         | 320–520 words      |

`scripts/response-length-benchmark.mjs` now sends the reasoning setting the app
sends, reports reasoning tokens beside completion tokens, and separates
"ended at the ceiling" from "ended mid-sentence". A run at `--reasoning off` and
`--reasoning unset` is what turns "the envelope is too small" into a measurement.

### 2.5 Truncation is stated, never papered over

A reply that stopped at the ceiling is reported — in the log and in the
completion event — and nothing generates a second turn about it. Silently
appending another model turn would double a reply the reader may be happy with,
and bill for it.

---

## 3. Diagnostics

`src/lib/generation-diagnostics.ts` writes exactly one line per turn covering
every stage from authorisation to provenance: the action, the regeneration
target and how it was resolved, the variant index, transcript rows loaded and
turns sent, the routing and reasoning state, the upstream host, HTTP status,
attempt, time to first token, finish reason, token counts, and a redacted
upstream body.

Failures and refusals are **always** written; successes need
`CHAT_GENERATION_DIAGNOSTICS=1` (on by default in development), because they are
the comparison set and one line per reply is a real cost.

It records identifiers, enumerations and counts. There is no field for prompt
text, reader message, memory content or character definition — structurally, not
by filtering — and the single free-text field goes through the same redaction the
provider log uses. `tests/generation-diagnostics.test.ts` asserts both.

---

## 4. Mobile layout

Found by measurement rather than by reading:
`scripts/viewport-overflow-audit.mjs` renders the real markup with the real
stylesheets in Chromium at 375/390/393/430/768/1024/1280/1440, with six title
shapes (short, long, unbroken, Cyrillic, emoji, descenders), and walks the tree
for the first element wider than its own box.

```
npm i --no-save playwright-core
node scripts/viewport-overflow-audit.mjs
```

**Before:** 38 of 48 chat combinations and 26 of 48 creation combinations
overflowed. **After:** all 96 fit.

### 4.1 The chat header

Two causes, both structural.

`.chat-panel` is a grid with no declared columns, so it had one implicit `auto`
track — sized to the **max-content** of its items. The header stretched the panel
from the inside no matter how shrinkable the panel itself was, and
`.app-shell{overflow:hidden}` then clipped the right-hand side: 399px of content
in a 375px panel. `grid-template-columns: minmax(0, 1fr)` plus
`.chat-panel > * { min-width: 0 }`.

And the previous title fix capped the title **against the viewport**:
`min(52vw, 520px)`, and `min(60vw, 320px)` on a phone. A viewport is not the
space the title has — on a 393px screen the header spends its width on padding, a
menu button, an avatar, two gaps and an action, leaving about 229px while 60vw
allows 236. A title long enough to reach its cap overflowed by a handful of
pixels, every time, which is exactly why the symptom depended on the *title*
rather than on the device. Every link from the header to the text can now shrink,
the actions cannot, and the title is capped at `100%` of what is left.

The descender fix from the earlier sprint is intact and still asserted.

### 4.2 Cast cards

Same class of bug: `.castList` is a grid with one implicit `auto` track, so one
member with an unbreakable name, a long Cyrillic role or a run of emoji set the
width of the list, the list set the width of the card, and the card ran off the
page. `minmax(0, 1fr)` on the track, `min-width: 0` on the card and its contents,
`max-width: 100%` on images. Type sizes are untouched.

### 4.3 The Creation call to action

- The `+` beside Start/Continue is gone, along with its rules. Beginning again is
  still a real action — inside the chat's story drawer, spelled out as "Start
  separate story", where it is not a glyph competing for the same thumb.
- On a phone the hero's CTA row is not rendered; the fixed bar is the only
  instance of both actions. On a wide screen there is no bar and the hero row is
  the only instance.
- The bar's blur, saturation and translucency are gone. It is the page's own
  surface colour with one hairline, and it uses the page's own buttons:
  `.actionBarSave` composes `.ghostButton` and only widens it enough for a label.
- Measured at 375/390/393/430: a 93px bar, two 52px controls, a 12px gap, 16px
  side insets, and 114px of reserved page padding, with both safe-area insets
  **added** to the padding rather than replacing it.

---

## 5. Navigation

### 5.1 Back into a chat

`popstate` is what pressing Back fires. The shell read the address, and the
address said "chat with creation X, story Y" — already exactly what was on
screen — and applied it as a navigation anyway. `openChatView` clears the
transcript, bumps the request nonce and sets `loading`, so the reader watched a
conversation they had just left blank itself and rebuild, with a second identical
request racing the first and either able to raise an error banner. The broken
transition was the chat genuinely being rebuilt underneath it.

`showsRoute` (`src/lib/chat-view.ts`) answers "is this address a different
place", and a route that names the story already open is now a no-op for the
transcript. A view showing nothing — including one whose load failed — still
counts as a different place, which is how Back recovers a chat that failed to
open.

### 5.2 Stale requests

- `setError` was being called **inside** a `setChatView` updater, which React may
  invoke twice and invokes during render. The nonce check now happens against the
  ref, before anything is set, on both the success and failure paths.
- `refreshChat` was guarded on the creation alone, so a refresh started for story
  A could land on story B of the same creation. It is guarded on the conversation
  now.
- A generation that outlives its chat — leaving a chat aborts nothing — could
  splice deltas into another story, remove a message from it, refresh it and
  raise a banner over it. Deltas, the completion bookkeeping and the failure path
  are all scoped to the conversation the turn belongs to.

### 5.3 The black page on Back out of a cast member

Not a paint problem: the router unmounts the creation page, so `detail` returns
to `null` and the whole creation is fetched again. The reader came *back* to a
page they had just been reading and got an empty one for a round trip.

Both standalone pages now keep a small, bounded, per-tab cache of what they have
already shown, so Back paints in the first frame and revalidates behind it. Both
abort the fetch they no longer need and refuse to let an aborted request become
an error.

Cast portraits are eager. A `loading="lazy"` image is evaluated against the
viewport as the page lays out, and a restored page lays out at scroll 0 and is
scrolled afterwards — so portraits below the fold at that instant were never
re-evaluated and stayed blank until the reader nudged the screen. The gallery
keeps lazy loading, which is what it is for.

No animation-completion callback is on any correctness path; none was, and none
was added.

---

## 6. Verification

| | |
|---|---|
| `npm test` | 119 files, 1756 passed, 7 skipped |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | compiles |
| `node scripts/viewport-overflow-audit.mjs` | 96/96 combinations fit |

The isolation suites need a PostgreSQL with `pgvector`; CI provides
`pgvector/pgvector:pg16`.

### Confirmed offline

Every defect in §0's table, each reproduced in a test before being fixed. The
80-turn acceptance run — 20 sends, 20 continues, 40 regenerations including
repeats on one reply — completes with no failures and 80 distinct provenance
rows, against real PostgreSQL. The overflow audit runs in a real browser.

That is a statement about what Afterglow builds, writes and renders. It is not a
statement about what an upstream does with any of it.

### Still requires live provider validation

- The production regenerate success rate, before and after. Nothing here
  measures it.
- **Which defect, if any, produced the reported failures.** Four were fixed;
  none is claimed to be *the* cause.
- GLM 5.3 Flash's actual error categories, and how often it returns
  `finish_reason: "length"` now that reasoning is genuinely declined.
- How often streams terminate without terminal evidence in production. The new
  `incomplete_transport` diagnostic is what will say; the rate is unknown today.
- Whether any routing constraint excludes every endpoint serving
  `z-ai/glm-5.3-flash`. `scripts/provider-constraint-bisect.mjs` answers it.
- Whether the response-length envelopes need retuning once reasoning is off.
  `scripts/response-length-benchmark.mjs --reasoning off|unset` answers it.
