# GLM 5.3 Flash: mandatory reasoning, and the envelope it was eating

What changed, why, and what an operator has to do about it. Written for whoever
has to reason about this at three in the morning.

Companion to `docs/glm-5.3-simplification-2026-09.md`, which is about *which
host* serves this model. Nothing about that changed here: GLM 5.3 Flash is still
`provider.only: ["z-ai"]`, fallbacks off, no `order`, no `sort`. This document
is about *what we ask that host for*.

## The failure, from the logs

Zero-length replies, no error, on every turn. The trace said all of it:

1. Afterglow sent `reasoning: { enabled: false }`, because the catalogue entry
   said `reasoningDefault: "off"`.
2. Z.AI answered **HTTP 400** — *"Reasoning is mandatory for this endpoint and
   cannot be disabled."*
3. The adapter's adaptation path dropped the parameter and asked again. Absent
   `reasoning` takes the **endpoint's own default**, which on an endpoint that
   mandates reasoning is *the most reasoning*, not the least.
4. The generation ended `finish_reason=length`, `native_finish_reason=length`,
   reasoning tokens only, `replyCharacters=0`.
5. `settings.maxTokens` was **1800**, and that number was being sent as the
   provider's **total** completion budget.

So there were two bugs wearing one symptom. The request was invalid on every
first attempt and recovered into the opposite of its own intention; and the
envelope could not have held an answer even when the request was valid, because
hidden reasoning tokens are billed and counted as completion tokens and were
therefore competing with the reply for the same 1,800.

## What the request looks like now

| | before | after |
|---|---|---|
| attempt 1 | `reasoning: { enabled: false }` → 400 | `reasoning: { effort: "low" }` → served |
| attempt 2 | no `reasoning` key (endpoint default) | *not needed* |
| `max_tokens` (Natural) | 1800 | 3800 |
| `provider` block | unchanged | unchanged |
| `session_id` | unchanged | unchanged |

`effort` is OpenRouter's own normalisation of a thinking budget; it is the only
way to say *less, but not none*, which is the intention `"off"` was standing in
for. `"minimal"` exists and is deliberately not chosen: a model that must reason
and is given almost no room to do it is the same failure with a smaller bill.

The `drop_reasoning` adaptation path is **unchanged and still in place**. It is
a safety net for an endpoint nobody has met yet. On this model it should now
never fire, and a `[provider] endpoint refused a parameter` line naming
`glm-5.3-flash` means the catalogue entry is wrong again.

## Reply length and completion budget are two numbers

Response Length keeps its semantics exactly. Concise, Natural and Detailed still
name what the reader **sees**, and the directives still ask for the same words.
What is new is headroom *on top* of that target:

```
providerMaxTokens = visibleReplyBudget + reasoningHeadroom
```

declared per model in `ModelCapabilities.reasoningBudget` and **absent for every
model that never had the problem** — a model with no declared budget sends
byte-for-byte the envelope it always sent. See `src/lib/reasoning.ts`.

For GLM 5.3 Flash: `headroomTokens: 2000`, `ceilingTokens: 8000`.

| Response Length | visible | on the wire | retry escalation |
|---|---|---|---|
| Concise | 594 | 2,594 | 4,594 |
| Natural | 1,800 | 3,800 | 5,800 |
| Detailed | 2,880 | 4,880 | 6,880 |

The headroom is a **ceiling, not a spend**: only tokens actually produced are
billed, so being generous costs nothing when the model behaves and one bounded
over-run when it does not.

## `reasoning_budget_exhausted`

`finish_reason == "length"` **and** no visible content **and** reasoning tokens
`> 0` is now its own provider category and its own generation failure reason,
separate from `empty_response`. The two have opposite remedies: an empty
response is a host that produced nothing and the answer is another host; this is
a host that produced a great deal, none of it visible, and the answer is a
larger envelope.

The reasoning evidence is read from **either** `delta.reasoning` frames **or**
`usage.completion_tokens_details.reasoning_tokens`, because endpoints differ in
which they give.

The reader's sentence is unchanged: *"The model did not return a reply. Please
try again."* Nothing about token envelopes reaches a reader.

## What a retry does

The empty-reply retry no longer repeats a request it has already watched fail.

- **Envelope exhausted, or reasoning cannot be declined** → raise the envelope
  by one more headroom, bounded by `ceilingTokens` and by whatever room the
  context budget actually left, and **stay on the same host** (the host was not
  the problem, and on a dedicated model there is nowhere else). Once. Never a
  ladder.
- **Anywhere `"off"` is accepted** → unchanged: ask for no reasoning, and avoid
  the host that produced nothing.

`retryMaxTokens` appears in the generation diagnostic when the retry asked for a
different envelope, which is the evidence it was not the identical request.

## Operator switches

| variable | effect |
|---|---|
| `RP_REASONING=off` | Declines reasoning on every model **that will accept the refusal**. GLM 5.3 Flash keeps its declared effort — honouring this literally there would rebuild the 400. |
| `RP_REASONING=auto` | Sends no `reasoning` key at all, on every model. Still valid on a mandatory endpoint: silence takes its default rather than contradicting it. This is the full revert. |
| `CHAT_GENERATION_DIAGNOSTICS=1` | One line per turn, including `reasoning`, `maxTokens`, `visibleReplyTokens`, `reasoningHeadroomTokens`, `retryMaxTokens`. |

Nothing here needs a deploy to undo.

## What has not been verified from this environment

OpenRouter's live endpoint catalogue is unreachable from the build sandbox
(egress to `openrouter.ai` is blocked), so **`z-ai/glm-5.3-flash`'s
`supported_parameters` list was not read directly**. `effort` is sent on the
strength of OpenRouter's documented reasoning schema, which normalises effort
across upstreams and maps an unsupported level to the nearest supported one. If
that endpoint turns out not to expose configurable effort, the correct change is
`reasoningDefault: undefined` on the catalogue entry — omit the control and take
the endpoint default — and `reasoningBudget` stays exactly as it is, because the
envelope problem is independent of it. `RP_REASONING=auto` is that change
without a deploy.

The token numbers are read off the observed failure, not off a measurement of
this model's reasoning length under `effort: "low"`. The first production window
should confirm `completionTokens` and `reasoningTokens` land inside 3,800 for a
Natural reply; if reasoning routinely exceeds ~2,000 tokens, raise
`headroomTokens` rather than `ceilingTokens`.
