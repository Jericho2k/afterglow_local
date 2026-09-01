import { randomUUID } from "node:crypto";
import { conversationCharacter, ownedConversation } from "@/lib/access";
import { commitNewAssistantMessage, commitRegeneratedVariant, ProvenanceConflictError, resolveRegenerationTarget } from "@/lib/regeneration";
import { createWriterStreamParser, streamEnding, truncatedByLength } from "@/lib/stream-parse";
import { logGeneration, reasonForCategory, type GenerationDiagnostic, type GenerationFailureReason, type GenerationStage } from "@/lib/generation-diagnostics";
import { logTimeline, startTimeline } from "@/lib/request-timing";
import { asUser, getUserSettings, messageFromRow, personaFromRow, worldFromRow } from "@/lib/db";
import { streamWriterCompletion, type LLMUsage } from "@/lib/llm";
import { maybeConsolidate, relevantContinuity } from "@/lib/memory";
import { focusedRetrievalQuery, maybeBackfillMemoryEmbeddings, maybeCurateCanon, memoryRetrievalV2Enabled, retrieveContinuityV2 } from "@/lib/memory-v2";
import { buildWriterPrompt, continueSceneCue, continuityPlacementFor, regenerateSceneCue, writerMessages } from "@/lib/prompts";
import { sceneStateEnabled, sceneStateRetrievalHintEnabled } from "@/lib/memory-flags";
import { sceneFieldsOf, sceneRetrievalCue } from "@/lib/scene-state";
import { currentSceneState, dropSceneStateForMessage, maybeUpdateSceneState } from "@/lib/scene-state-store";
import { conversationWorldRecords, ensureConversationWorlds } from "@/lib/conversation-worlds";
import { anchoredFetchLimit, recallText, selectAnchoredMessages } from "@/lib/context";
import { chatSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { defaultReasoningFor, modelCapabilities, modelVerbosity, providerModelId, resolveEngine, resolveModel, taskModelSelection } from "@/lib/provider";
import { responseLengths, type AppSettings, type ResponseLength } from "@/lib/types";
import { responseLengthPlan } from "@/lib/response-length";
import { contextExceededMessage, fitConversation } from "@/lib/context-budget";
import { inferenceSessionId } from "@/lib/inference-session";
import { ProviderError, classifyProviderFailure, logProviderDiagnostic, publicErrorMessage, publicErrorStatus } from "@/lib/provider-errors";
import { ByokError, type InferenceFunding } from "@/lib/byok";
import { acceptFundedFallback, credentialFor, planWriterFunding, settleWriterFunding, type WriterFundingPlan } from "@/lib/writer-funding";
import { freeTierConfig } from "@/lib/free-tier";
import { routeGenerationAllowed } from "@/lib/curated-routes";
import { recordRouteOutcome } from "@/lib/route-health";
import { isFreeModel } from "@/lib/provider";

function writerErrorMessage(error: unknown, funding: InferenceFunding) {
  if (funding.type === "byok" && error instanceof ProviderError) {
    if (error.category === "auth") return "Your OpenRouter key is no longer valid. Reconnect it in Settings.";
    if (error.category === "billing") return "Your OpenRouter account couldn't fund this request. Check your OpenRouter credits.";
  }
  return publicErrorMessage(error);
}

export const maxDuration = 120;

export async function POST(request: Request) {
  // Authorisation happens before anything is written and, critically, before
  // any paid model call: an unauthenticated or unauthorised request must never
  // reach DeepSeek.
  /*
   * The timeline for this turn.
   *
   * Nothing between "tap send" and "first token" was measured, which is why
   * "some replies take close to a minute" could only ever be answered with a
   * guess. See src/lib/request-timing.ts; it records stage names and durations
   * and never content.
   */
  const timeline = startTimeline();
  const account = await currentAccount();
  if (!account) return unauthorized();
  timeline.mark("auth");
  const limited = checkRateLimit(`chat:${account.id}`, 60, 60_000); if (limited) return limited;
  const ipLimited = checkRateLimit(`chat-ip:${clientIp(request)}`, 120, 60_000); if (ipLimited) return ipLimited;
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const { conversationId, content, action, acceptFundedFallback: fundedFallbackAccepted } = parsed.data;
  if (action === "send" && !content) return Response.json({ error: "Message cannot be empty" }, { status: 400 });

  /*
   * THE TURN'S OWN RECORD.
   *
   * Send worked, Continue worked, Regenerate failed "almost every attempt", and
   * nothing in the logs could say what was different about the third one —
   * because the three were never recorded in a form that could be compared. So
   * every turn now fills this in as it goes and writes exactly one line at the
   * end, whichever way it ends. `stage` is the last thing that completed, so on
   * a failure it IS the failing stage.
   *
   * Identifiers, enumerations and counts only. See generation-diagnostics.ts.
   */
  const diagnostic: GenerationDiagnostic = { conversationId, action, outcome: "failed", stage: "authorised" };
  const at = (stage: GenerationStage) => { diagnostic.stage = stage; };
  /** Ends the turn's record. Called on every exit, including the happy one. */
  const finish = (outcome: GenerationDiagnostic["outcome"], reason?: GenerationFailureReason) => {
    diagnostic.outcome = outcome;
    if (reason) diagnostic.reason = reason;
    logGeneration(diagnostic);
  };
  /** A refusal the reader can act on: recorded, then answered. */
  const refuse = (body: Record<string, unknown>, status: number, reason: GenerationFailureReason) => {
    finish("refused", reason);
    return Response.json(body, { status });
  };

  // Phase one: resolve and validate everything the prompt needs, inside a
  // single account-scoped transaction.
  const prepared = await asUser(account.id, async (client) => {
    const row = await ownedConversation(client, account.id, conversationId);
    if (!row) return { error: "Conversation not found" as const };
    const { character } = await conversationCharacter(client, account.id, row);
    if (!character) return { error: "Character not found" as const };

    const settings = await getUserSettings(client, account.id);
    /*
     * The worlds THIS STORY is written with.
     *
     * Not the Creation's — that is the whole point of the change. A story
     * receives a copy of the Creation's readable defaults when it begins and
     * owns its set from then on, so attaching a world here cannot reach into
     * the Creation, into the creator's published canon, or into anybody else's
     * story. `ensureConversationWorlds` gives a story written before the
     * relation existed its set on first use; after that it is one indexed read.
     *
     * Readability is re-checked inside `conversationWorldRecords`, so a world
     * whose creator makes it private stops feeding this prompt immediately
     * even though the link survives. See src/lib/conversation-worlds.ts.
     */
    await ensureConversationWorlds(client, account.id, row);
    /*
     * The worlds and the persona are independent reads, so they are one wait
     * rather than two.
     *
     * Everything in this handler used to be strictly sequential, and against a
     * pooled remote database every statement is a network leg the reader waits
     * through before a single token appears. These two have nothing to say to
     * each other; only `ensureConversationWorlds` above has to come first,
     * because the read below depends on what it writes.
     */
    const [worldRows, personaResult] = await Promise.all([
      conversationWorldRecords(client, account.id, conversationId),
      row.persona_id
        ? client.query("SELECT * FROM personas WHERE id=$1 AND user_id=$2", [row.persona_id, account.id])
        : client.query("SELECT * FROM personas WHERE user_id=$1 AND is_default=true LIMIT 1", [account.id]),
    ]);

    return {
      row,
      character,
      settings,
      worlds: worldRows.map((world) => worldFromRow(world)),
      persona: personaResult.rows[0] ? personaFromRow(personaResult.rows[0]) : null,
    };
  });
  timeline.mark("conversation+creation+worlds+persona");
  if ("error" in prepared) { finish("refused", "unknown"); return Response.json({ error: prepared.error }, { status: 404 }); }
  at("conversation_loaded");
  const { row, character, settings, worlds, persona } = prepared;
  const conversationSelection = {
    providerId: String(row.provider_id || settings.providerId),
    modelId: String(row.model_id || settings.model),
  };
  let selection: typeof conversationSelection;
  try {
    selection = taskModelSelection("rp_generation",conversationSelection);
  } catch (error) {
    // A deployment routing mistake is an operator problem. The reader is told
    // what they can act on, not what the environment variable is called.
    console.error("[provider] RP_MODEL_ROUTE is misconfigured", error instanceof Error ? error.message : error);
    return refuse({ error: "This chat's model is not available on this deployment. Choose another model in chat tools.", reason: "model_unavailable" }, 409, "model_unavailable");
  }
  const engineId = String(row.rp_engine_id || settings.roleplayPreset) as AppSettings["roleplayPreset"];
  const storedResponseLength = String(row.response_length || "");
  const responseLength: ResponseLength = responseLengths.includes(storedResponseLength as ResponseLength) ? storedResponseLength as ResponseLength : settings.responseLength;
  const temperature = row.temperature == null ? settings.temperature : Math.min(2,Math.max(0,Number(row.temperature)));
  const conversationModelDefinition = resolveModel(conversationSelection.providerId,conversationSelection.modelId);
  const modelDefinition = resolveModel(selection.providerId, selection.modelId);
  const engineDefinition = resolveEngine(engineId);
  /*
   * Model retirement, handled rather than crashed into.
   *
   * A conversation stores the provider and model it was started with, and an
   * upstream model can be retired underneath it. That must not turn the whole
   * chat into a mystery: the reply is refused with a sentence that says what
   * happened and what to do, and `reason` lets the client offer the model
   * picker directly. Nothing is silently substituted — the writer a reader
   * chose is never swapped for another one behind their back.
   */
  if (!conversationModelDefinition || !modelDefinition || !engineDefinition) {
    return refuse({
      error: !engineDefinition
        ? "This chat's roleplay engine is no longer available. Choose another one in chat tools."
        : "This chat's model is no longer available. Choose another model in chat tools — your story, memories and settings are untouched.",
      reason: !engineDefinition ? "engine_unavailable" : "model_unavailable",
    }, 409, "model_unavailable");
  }
  at("model_resolved");
  diagnostic.provider = selection.providerId;
  diagnostic.model = selection.modelId;
  diagnostic.upstreamModel = providerModelId(selection.providerId, selection.modelId) ?? selection.modelId;
  diagnostic.responseLength = responseLength;
  diagnostic.temperature = temperature;
  diagnostic.conversationMessages = Number(row.message_count || 0);

  /*
   * A CURATED ROUTE CAN BE WITHDRAWN BETWEEN CHOOSING IT AND USING IT.
   *
   * The picker's answer is minutes old and a free endpoint's lifetime is
   * measured in hours. Asked here, before the reader's turn is persisted, so a
   * route the server has since disabled produces the same calm "choose another
   * model" the retirement path produces rather than a failure mid-stream.
   */
  if (isFreeModel(selection.modelId)) {
    const routeState = await routeGenerationAllowed(selection.modelId);
    if (!routeState.allowed) {
      return refuse({
        error: routeState.reason === "disabled"
          ? "This free model is no longer offered. Choose another model in chat tools — your story, memories and settings are untouched."
          : "This free model is temporarily unavailable. Choose another model in chat tools, or try again shortly.",
        reason: "model_unavailable",
      }, 409, "model_unavailable");
    }
  }

  /*
   * WHO PAYS, DECIDED ONCE, BEFORE A SEND PERSISTS THE READER'S TURN.
   *
   * Four possible answers and four different consequences — which credential is
   * sent, which ledger is debited, what a failure gives back, what a refusal
   * says — all resolved in src/lib/writer-funding.ts rather than here. A free
   * route reserves its slot from the shared daily pool at this point, so two
   * readers cannot both take the last one, and the reservation is settled after
   * the stream ends whichever way it ends.
   *
   * Nothing here reads or decrypts a secret column: that still happens
   * immediately before the outgoing request, further down.
   */
  let fundingPlan: WriterFundingPlan;
  try {
    /*
     * The reader may have already been asked and already said yes.
     *
     * `acceptFundedFallback` means the previous turn was refused with a funded
     * writer named, and this request is the answer. The guards run again rather
     * than being trusted from the earlier decision — the budget may have gone
     * in the seconds between — and the slot is taken only now.
     */
    const decision = fundedFallbackAccepted && isFreeModel(selection.modelId)
      ? await acceptFundedFallback({ userId: account.id, modelId: freeTierConfig().fundedModelId ?? "" })
      : await planWriterFunding({ userId: account.id, selection });
    timeline.mark("funding-preflight");
    if (decision.kind === "refused") {
      /*
       * The free tier's refusal is a PRODUCT answer, not an error.
       *
       * It carries what the reader can do about it — wait for the reset,
       * connect their own key, choose a paid model, or accept a writer
       * Afterglow will fund — and the funded option is named rather than taken,
       * because changing somebody's writer is their decision to make.
       */
      return refuse({
        error: decision.message,
        reason: "free_capacity_exhausted",
        remedies: decision.remedies,
        ...(decision.fundedModelId ? { fundedModelId: decision.fundedModelId } : {}),
        resetsAt: decision.resetsAt,
      }, 429, "free_capacity_exhausted");
    }
    fundingPlan = decision;
  } catch (error) {
    if (error instanceof ByokError) return refuse({ error: error.message, reason: error.code }, 409, "auth");
    finish("failed", "unknown");
    throw error;
  }
  at("funding_planned");
  /*
   * The funding plan may name a different model from the one the conversation
   * stores — only ever when a deployment has set the funded fallback to `auto`,
   * and only ever toward the one model that deployment named. It is reported in
   * the response and written to the ledger; it is never silent.
   */
  selection = fundingPlan.selection;
  const fundingSource = fundingPlan.kind;
  diagnostic.fundingSource = fundingSource;
  diagnostic.provider = selection.providerId;
  diagnostic.model = selection.modelId;
  diagnostic.upstreamModel = providerModelId(selection.providerId, selection.modelId) ?? selection.modelId;
  /** Settle exactly once, whichever way this request ends. */
  let fundingSettled = false;
  const settleFunding = async (ran: boolean) => {
    if (fundingSettled) return;
    fundingSettled = true;
    await settleWriterFunding(fundingPlan, ran);
  };

  // Memory maintenance is deliberately not on the reply's critical path. The
  // recent transcript already carries the newest accepted turns, while the
  // rolling summary is updated in the background after successful replies.
  const currentSummary = String(row.summary || "");
  const sceneEnabled = sceneStateEnabled(account.id);
  /*
   * The writer's own habits are part of the request.
   *
   * Declared beside the model rather than compared by name here; see
   * `ModelCapabilities.verbosity`. It changes one line of the concise directive
   * and nothing else about what is sent.
   */
  const writerVerbosity = modelVerbosity(selection.providerId, selection.modelId);

  const staged = await asUser(account.id, async (client) => {
    let regenerateTarget: ReturnType<typeof messageFromRow> | null = null;
    let targetSource: GenerationDiagnostic["targetSource"] = "none";
    let userMessageId: string | null = null;

    if (action === "send") {
      userMessageId = parsed.data.userMessageId ?? randomUUID();
      await client.query("INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id) VALUES ($1,$2,$3,'user',$4,$1)", [userMessageId, conversationId, account.id, content]);
      await client.query(
        `UPDATE conversations SET message_count=message_count+1,updated_at=now(),
         title=CASE WHEN message_count <= 1 AND title LIKE 'Chat with %' THEN left($2,120) ELSE title END WHERE id=$1 AND user_id=$3`,
        [conversationId, content.replace(/\s+/g, " "), account.id],
      );
    } else if (action === "regenerate") {
      /*
       * WHICH REPLY IS BEING REGENERATED, ASKED RATHER THAN ASSUMED.
       *
       * This used to be "the newest row, if it is an assistant" and nothing
       * else — the `assistantMessageId` the browser sends was read only as a
       * fallback id for an INSERT. So when the newest row was not what the
       * reader was looking at, the wrong reply was rewritten; and when it was
       * a user turn, the target became null and the "regeneration" inserted a
       * new message under a client-guessed id, which collides with a real row
       * as often as not and surfaced as "That reply could not be saved".
       *
       * See src/lib/regeneration.ts for the three cases and why a superseded
       * target is refused rather than substituted.
       */
      const resolved = await resolveRegenerationTarget(client, {
        conversationId, userId: account.id, requestedMessageId: parsed.data.assistantMessageId ?? null,
      });
      if (!resolved.ok) return { regenerateFailure: resolved.reason };
      regenerateTarget = resolved.message;
      targetSource = resolved.source;
      // The reply about to be replaced may have moved the scene. Dropping the
      // state read out of it here means the discarded generation cannot leave
      // its location, cast, or open loops behind, whatever happens next.
      if (sceneEnabled) await dropSceneStateForMessage(client,conversationId,regenerateTarget.id,account.id);
    }

    /*
     * The transcript, and the scene it happens in, read together.
     *
     * THE COUNT QUERY IS GONE. This used to follow the transcript read with
     * `SELECT COUNT(*) FROM messages` purely to place the anchored window's
     * quantised start — a full index scan of the conversation, growing with
     * exactly the thing the product wants people to do, on the critical path of
     * every single reply. The conversation row already carries `message_count`
     * and this transaction has just incremented it.
     *
     * A stale count is harmless here in a way it would not be elsewhere:
     * `selectAnchoredMessages` takes `Math.max(total, available.length)`, so
     * under-counting can only widen the window, never narrow it. It is a cache
     * hint, not a correctness input.
     */
    const [historyResult, sceneState] = await Promise.all([
      client.query(
        "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3",
        [conversationId, account.id, anchoredFetchLimit(settings.contextMessages)],
      ),
      // Read after any regeneration cleanup above, so a replaced generation's
      // scene is already out of the way.
      sceneEnabled ? currentSceneState(client,account.id,conversationId) : Promise.resolve(null),
    ]);
    /*
     * HOW MANY MESSAGES THE WINDOW IS BEING DRAWN FROM.
     *
     * This is the absolute reference `selectAnchoredMessages` quantises the
     * window's start against, and it was wrong for exactly one action.
     * Regenerate EXCLUDES its target from the rows it selects from, but the
     * count still included it — so the anchor arithmetic was off by one and
     * the window began one message earlier than the send that produced the
     * same reply. That is a different first token, which is a complete prompt
     * cache miss, on every regeneration, for the one model family whose whole
     * routing policy is built on cache reads being most of the bill.
     *
     * Regenerate was therefore the only action that never hit a warm cache.
     * WHAT THAT COSTS IS COST AND LATENCY, and that is the whole of the claim:
     * every regeneration paid fresh input rates for a prompt the send beside it
     * had cached, and waited for it. It is NOT a reason a provider would refuse
     * the request — `max_price` filters endpoints on their LIST PRICING, not on
     * what one prompt happens to bill, so a larger fresh-input bill cannot push
     * a valid request through that ceiling. Whether anything about routing was
     * refusing these requests in production is a separate question and an open
     * one; see docs/chat-reliability-2026-09.md.
     *
     * Subtracting the excluded row makes the regenerated turn's window
     * byte-identical to the send's.
     */
    const knownMessageCount = Number(row.message_count || 0)
      + (action === "send" ? 1 : 0)
      - (regenerateTarget ? 1 : 0);
    const availableHistory = historyResult.rows.reverse().map(messageFromRow).filter((message) => message.id !== regenerateTarget?.id);
    // Anchored rather than strictly sliding: the same transcript the budget
    // would have selected, with its start quantised so a provider's prompt
    // cache survives more than one turn. Never fewer messages than before.
    const history = selectAnchoredMessages(availableHistory, Math.max(knownMessageCount, availableHistory.length), settings.contextMessages, settings.contextTokenBudget);
    const lastUserInput = [...history].reverse().find((message) => message.role === "user")?.content ?? content;
    const recallContext = recallText(history, lastUserInput || character.scenario || character.name);
    return { regenerateTarget, targetSource, userMessageId, history, lastUserInput, recallContext, sceneState, knownMessageCount, transcriptRowsLoaded: historyResult.rowCount ?? historyResult.rows.length };
  });
  timeline.mark("transcript+scene");

  /*
   * A regeneration with nothing to regenerate is a product answer, not a 500.
   *
   * `target_superseded` means the reader's browser is looking at a story that
   * has moved on — another tab replied, or their own Continue landed while
   * their thumb was on Regenerate. Rewriting whatever is newest now would
   * silently replace a reply they never chose.
   */
  if ("regenerateFailure" in staged) {
    at("target_resolved");
    diagnostic.targetMessageId = parsed.data.assistantMessageId ?? null;
    return staged.regenerateFailure === "target_superseded"
      ? refuse({ error: "This story has moved on since this reply was shown. Reload the chat and try again.", reason: "regenerate_target_stale" }, 409, "regenerate_target_missing")
      : refuse({ error: "There is no reply to regenerate yet.", reason: "regenerate_target_missing" }, 409, "regenerate_target_missing");
  }

  const { regenerateTarget, targetSource, userMessageId, history, lastUserInput, recallContext, sceneState, knownMessageCount, transcriptRowsLoaded } = staged;
  at("transcript_loaded");
  diagnostic.targetMessageId = regenerateTarget?.id ?? null;
  diagnostic.targetSource = targetSource;
  diagnostic.existingVariants = regenerateTarget ? regenerateTarget.variants.length : null;
  diagnostic.messagePosition = regenerateTarget ? Number(row.message_count || 0) : null;
  diagnostic.transcriptRowsLoaded = transcriptRowsLoaded;
  // Selection stays relevance-driven. The cue is opt-in and additive so an
  // A/B comparison can separate grounding from ranking.
  const sceneRetrievalHint = sceneState && sceneStateRetrievalHintEnabled() ? sceneRetrievalCue(sceneFieldsOf(sceneState)) : "";
  if (!lastUserInput && action !== "continue") return refuse({ error: "Nothing to regenerate", reason: "regenerate_target_missing" }, 400, "regenerate_target_missing");

  const continuationRetrievalAnchor = action === "continue" && history.at(-1)?.role === "assistant" ? history.at(-1)!.content : "";
  let memories; let arcs; let coreCanon = [] as Awaited<ReturnType<typeof retrieveContinuityV2>>["coreCanon"];
  /** The retrieval run this reply was written from, when V2 produced one. */
  let retrievalRunId = "";
  if (memoryRetrievalV2Enabled(account.id)) {
    try {
      const continuity = await retrieveContinuityV2({
        userId:account.id,characterId:row.character_id,conversationId,
        // A continuation is asked about where the scene IS, not about the turn
        // that is already answered, so its retrieval anchor is the reply being
        // continued rather than the reader's older message.
        query:focusedRetrievalQuery(history,(action === "continue" ? continuationRetrievalAnchor : "") || lastUserInput || character.scenario || character.name,sceneRetrievalHint),
        messageId:userMessageId,limit:settings.memoryLimit,tokenBudget:settings.memoryTokenBudget,
        /*
         * Where the story has reached, in the story's own units.
         *
         * Aging used to be measured on the wall clock, which is the wrong clock
         * for fiction: a roleplay can sit untouched for three real months while
         * five fictional minutes pass, and every promise in it would go stale
         * inside a scene that had not moved. Message count and the live scene's
         * story day are the two clocks that actually track the story.
         */
        at:{ messageCount:knownMessageCount, storyDay:sceneState ? sceneFieldsOf(sceneState).storyDay ?? null : null },
      });
      ({memories,arcs,coreCanon}=continuity);
      retrievalRunId = continuity.diagnostics.runId;
    } catch (error) {
      // Schema/configuration mistakes must not take chat down during the staged
      // rollout. The complete V1 path remains the operational fallback.
      console.error("Memory Retrieval V2 failed; using V1",error);
      ({memories,arcs}=await asUser(account.id,(client)=>relevantContinuity(client,account.id,row.character_id,conversationId,recallContext,settings.memoryLimit,settings.memoryTokenBudget)));
    }
    timeline.mark("memory-retrieval");
  } else {
    ({memories,arcs}=await asUser(account.id,(client)=>relevantContinuity(client,account.id,row.character_id,conversationId,recallContext,settings.memoryLimit,settings.memoryTokenBudget)));
    timeline.mark("memory-retrieval");
  }

  // With the layer off, the writer prompt is byte-identical to today's: no
  // scene block, and no historical tags even on memories stamped while it was
  // on. That is what makes an enabled/disabled comparison mean something.
  at("memory_retrieved");
  const groundedMemories = sceneEnabled ? memories : memories.map((memory) => ({ ...memory, scene: null }));
  const groundedArcs = sceneEnabled ? arcs : arcs.map((arc) => ({ ...arc, storyDayStart: null, storyDayEnd: null, locations: [] }));
  const writerPrompt = buildWriterPrompt(character, currentSummary, groundedMemories, groundedArcs, { ...settings, roleplayPreset: engineId, responseLength }, {
    worlds,
    persona,
    coreCanon,
    sceneState: sceneState ? sceneFieldsOf(sceneState) : null,
    instructionPresets: Array.isArray(row.instruction_presets) ? row.instruction_presets : [],
    customInstructions: String(row.custom_instructions || ""),
    modelVerbosity: writerVerbosity,
  });
  const modelHistory = history.map((message) => ({ role: message.role, content: message.content }));
  /*
   * Continue is a continuation, not another attempt.
   *
   * Two conditions have to hold for that to be true, and neither used to be
   * checked. The transcript must actually END with the reply being continued —
   * a "continue from your last reply" instruction with no last reply in the
   * transcript is exactly the state in which the writer answers the reader's
   * earlier turn again, which is Regenerate wearing Continue's label. And the
   * cue must name where to start, which is why it quotes that reply's final
   * sentences back; see `continueSceneCue`.
   *
   * When there is nothing to continue from — a reply that failed to persist, a
   * story whose newest message is the reader's — the cue is omitted entirely
   * and this becomes an ordinary generation. That is the honest behaviour: a
   * next reply is what the reader wanted, and pretending to continue from a
   * reply that is not there is what produced the bug.
   */
  const continuedReply = action === "continue" && history.at(-1)?.role === "assistant" ? history.at(-1)!.content : "";
  if (action === "continue" && continuedReply.trim()) modelHistory.push({ role: "user", content: continueSceneCue(continuedReply) });

  /*
   * A REGENERATION MUST STILL END ON SOMETHING THAT TRIGGERS A GENERATION.
   *
   * Removing the target normally leaves the reader's own turn at the end of the
   * transcript, which is a complete request and is left exactly alone.
   *
   * It does not when the reply being replaced itself followed a reply — the
   * ordinary state after Continue. The transcript then ends on an ASSISTANT
   * message, and a chat API given a trailing assistant turn is being asked to
   * EXTEND it: several upstreams treat it as a prefill, so the "regeneration"
   * comes back as a continuation of a message the reader has already accepted.
   * Putting the continuity block last instead is well formed and merely odd —
   * the final thing the writer reads is background rather than a turn.
   *
   * So this shape gets an explicit control turn, and the request ends where a
   * chat API expects a generation to start from. See `regenerateSceneCue`; it
   * deliberately does not quote the reply being replaced, because an
   * alternative to a reply is not written by showing the writer that reply.
   */
  const regenerateTailIsReply = action === "regenerate" && modelHistory.at(-1)?.role === "assistant";
  if (regenerateTailIsReply) modelHistory.push({ role: "user", content: regenerateSceneCue() });

  /*
   * Fit the request to the model before sending it.
   *
   * See src/lib/context-budget.ts for why the order is envelope, then budgeted
   * layers, then refuse. The short version is that Midnight Cherry reads 32,768
   * tokens and a World can be 28,000 of them, so "assemble and hope" produced a
   * 400 that reached the reader as "Something went wrong".
   */
  at("prompt_built");
  const capabilities = modelCapabilities(selection.providerId, selection.modelId);
  const placement = continuityPlacementFor(capabilities.promptCaching);
  const lengthPlan = responseLengthPlan(responseLength, settings.maxTokens, writerVerbosity);
  // Budgeting reads the whole prompt regardless of how it will be delivered:
  // the tokens are the same either way, only their position changes.
  const fitted = fitConversation(modelHistory, {
    capabilities,
    systemPrompt: `${writerPrompt.head}\n\n${writerPrompt.continuity}`,
    requestedMaxTokens: lengthPlan.maxTokens,
  });
  if (fitted.plan.overflows) {
    // The static material alone does not fit. Truncating a creator's canon to
    // force it through would produce a confident, wrong reply; naming the
    // remedy is the honest answer, and `reason` lets the client open the picker.
    logProviderDiagnostic("rp generation refused: context exceeded", new ProviderError("bad_request", {
      conversationId, provider: selection.providerId, model: selection.modelId,
      detail: `prompt ${fitted.plan.promptTokens} tokens exceeds ${capabilities.contextTokens} context by ${fitted.plan.overflowTokens}`,
    }));
    // Nothing was generated, so nothing was spent: the free-tier slot goes back.
    await settleFunding(false);
    diagnostic.promptTokensEstimated = fitted.plan.promptTokens;
    return refuse({ error: contextExceededMessage, reason: "context_exceeded" }, 409, "context_exceeded");
  }
  if (fitted.dropped) {
    // A quality change nobody asked for is worth recording even when it is the
    // right call. The window recovers on the next turn if the model changes.
    console.warn("[context] transcript trimmed to fit the model", JSON.stringify({
      conversationId, model: selection.modelId, dropped: fitted.dropped,
      promptTokens: fitted.plan.promptTokens, contextTokens: capabilities.contextTokens,
    }));
  }
  at("budget_planned");
  diagnostic.promptTokensEstimated = fitted.plan.promptTokens;
  diagnostic.maxTokens = fitted.plan.maxTokens;
  diagnostic.transcriptMessagesSent = fitted.messages.length;
  diagnostic.transcriptTrimmed = fitted.dropped ?? 0;
  const completionMessages = writerMessages(writerPrompt, fitted.messages, placement);
  let writerFunding: InferenceFunding = { type: "afterglow" };
  try {
    // The ciphertext is read and decrypted only now: after context assembly,
    // directly before the request that needs it. Nothing stores the result.
    // For every funding kind but BYOK this resolves to platform funding without
    // touching a secret column at all.
    writerFunding = await credentialFor(account.id, fundingPlan);
  } catch (error) {
    if (error instanceof ByokError) {
      // A reservation taken for a request that is about to be refused has to go
      // back, or a configuration fault would quietly eat the reader's day.
      await settleFunding(false);
      return refuse({ error: error.message, reason: error.code }, error.code === "server_configuration" ? 503 : 409, "auth");
    }
    await settleFunding(false);
    finish("failed", "unknown");
    throw error;
  }
  // Response Length owns the output envelope as well as the directive. The
  // account's `maxTokens` is the Natural baseline the other two scale from, so
  // Concise has a genuinely lower ceiling than Detailed without any mode ever
  // being cut off: see src/lib/response-length.ts for why each ceiling sits
  // far above the words its own directive asks for. `lengthPlan` is computed
  // above, before budgeting, because budgeting may lower this ceiling to fit.
  const completionOptions = {
    signal: request.signal,
    maxTokens: fitted.plan.maxTokens,
    temperature,
    /*
     * Reasoning is asked for only when the ENGINE wants it and the ENDPOINT
     * accepts it. Sending `reasoning` to a model that rejects unknown
     * parameters is a 400 with the reader's turn attached to it.
     *
     * WHEN THE ENGINE DOES NOT WANT IT there are two different things to send,
     * and which one is right is a measurement nobody has taken yet. Saying
     * nothing takes the endpoint's default, which on a hybrid reasoning model
     * such as GLM 4.7 may well be reasoning — billed as output tokens, at
     * output prices, for a roleplay reply that never shows it. Saying "none"
     * explicitly stops that, and might also cost some quality.
     *
     * So the default is UNCHANGED and the alternative is one variable away:
     * `RP_REASONING=off` makes six of the seven engines decline reasoning
     * outright. The A/B that would justify flipping it is
     * `scripts/glm-routing-benchmark.mjs --reasoning`, and until somebody has
     * run it this stays where it is.
     */
    /*
     * WHAT THE CATALOGUE SAYS ABOUT THIS MODEL IS NOW ACTUALLY SENT.
     *
     * `defaultReasoningFor` has existed since the model expansion and was
     * called by nothing at all, so GLM 5.3 Flash's `reasoningDefault: "off"` —
     * added because that model reasons before it speaks, with a measured
     * time-to-first-token in the TENS OF SECONDS — did nothing. Omitting the
     * `reasoning` parameter is not declining reasoning, it is declining to have
     * an opinion, and a hybrid reasoning model's own opinion is to reason.
     *
     * The consequence was not only latency. Reasoning tokens are spent from the
     * SAME output envelope as the prose, so a Natural reply with 1,800 tokens
     * of room could spend most of it thinking and then be cut off mid-sentence
     * at `finish_reason: "length"` — which is the "responses are being cut off"
     * report, arriving without an error because nothing was reading the finish
     * reason.
     *
     * Precedence is unchanged and deliberate: an engine that WANTS reasoning
     * still gets it; `RP_REASONING=off` is still the deployment-wide override;
     * a model that declares no default still sends nothing, which is exactly
     * today's behaviour for every model but the three that declare one.
     */
    thinking: engineDefinition.thinking && capabilities.thinking
      ? true
      : capabilities.thinking && defaultReasoningFor(selection.modelId) === "off" ? "off" as const : false,
    /** The catalogue model id, so routing policy can be chosen per model. */
    modelId: selection.modelId,
    // Conversation-scoped provider stickiness. Sequential turns in one story
    // ask for the same upstream host, which is what lets its prompt cache stay
    // warm; a different story is a different session and shares nothing.
    sessionId: inferenceSessionId("rp_generation", conversationId),
  };
  diagnostic.sessionScoped = Boolean(completionOptions.sessionId);
  diagnostic.reasoning = completionOptions.thinking === true ? "on" : completionOptions.thinking === "off" ? "off" : "unset";
  let upstream: ReadableStream<Uint8Array>;
  const requestStartedAt = Date.now();
  timeline.mark("provider-request-started");
  at("provider_requested");
  try {
    upstream = await streamWriterCompletion(selection,completionMessages,writerFunding,completionOptions);
    // The provider accepted the request and handed back a stream. Everything
    // after this mark is the model thinking; everything before it is ours.
    timeline.mark("provider-accepted");
  } catch (error) {
    // The operator gets the status, the route and the upstream body; the
    // reader gets one sentence. These are two different strings on purpose —
    // returning `error.message` here is what used to put raw provider JSON
    // inside a roleplay.
    logProviderDiagnostic("rp generation failed before streaming", error instanceof ProviderError
      ? error.withDiagnostic({ conversationId, provider: selection.providerId, model: selection.modelId })
      : error);
    /*
     * The request never reached a model, so the reader gets their allowance
     * back — and the route gets a failure recorded against it, separating a
     * capacity refusal from a fault so a busy free endpoint reads as busy
     * rather than as broken.
     */
    await settleFunding(false);
    void recordRouteOutcome({
      modelId: selection.modelId, ok: false,
      capacity: error instanceof ProviderError && error.category === "rate_limited",
    });
    if (error instanceof ProviderError) {
      diagnostic.category = error.category;
      diagnostic.status = error.diagnostic.status;
      diagnostic.attempt = error.diagnostic.attempt;
      diagnostic.requestId = error.diagnostic.requestId;
      diagnostic.upstreamProvider = error.diagnostic.upstreamProvider;
      diagnostic.latencyMs = error.diagnostic.latencyMs ?? null;
      diagnostic.detail = error.diagnostic.detail;
    } else {
      diagnostic.detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }
    finish("failed", error instanceof ProviderError ? reasonForCategory(error.category) : "unknown");
    return Response.json({ error: writerErrorMessage(error, writerFunding) }, { status: publicErrorStatus(error) });
  }
  at("provider_accepted");
  /*
   * Analytics, not a precondition.
   *
   * This is one more database round trip sitting directly between the finished
   * prompt and the provider request — the last thing the reader waits through
   * before anything can start streaming — and nothing downstream reads it. It
   * is fired and not awaited.
   */
  if (userMessageId) {
    void asUser(account.id, (client) => client.query(
      "UPDATE messages SET generation_started_at=COALESCE(generation_started_at,now()) WHERE id=$1 AND user_id=$2 AND role='user'",
      [userMessageId, account.id],
    )).catch((error) => console.error("Generation start stamp failed", error));
  }
  timeline.mark("prompt-built");

  const encoder = new TextEncoder();
  const assistantId = regenerateTarget?.id ?? parsed.data.assistantMessageId ?? randomUUID();
  const responseStream = new ReadableStream({
    async start(controller) {
      let usage: LLMUsage | null = null;
      let actualProviderModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
      let upstreamProvider: string | undefined;
      let ttftMs: number | undefined;
      let retried = false;
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      /*
       * The stream, parsed by src/lib/stream-parse.ts rather than inline.
       *
       * The parser that used to live here dropped its final buffered line —
       * a `data:` frame arriving without a trailing newline, which is what a
       * connection closing on the last write produces — so the closing
       * sentence of a reply could simply vanish. That is the reported
       * "responses are being cut off", with no error to explain it because
       * nothing had gone wrong from the route's point of view. It now also
       * records `finish_reason`, which is the difference between "the model
       * finished" and "we did not give it room".
       */
      const parser = createWriterStreamParser((delta) => {
        if (ttftMs === undefined) { ttftMs = Math.max(0, Date.now() - streamStartedAt); timeline.mark("first-token"); at("first_token"); }
        send({ type: "delta", content: delta });
      });
      let streamStartedAt = requestStartedAt;
      const consume = async (stream: ReadableStream<Uint8Array>, startedAt: number) => {
        streamStartedAt = startedAt;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(value);
          }
        } finally {
          // Always, and before anything reads the outcome: this is what flushes
          // a partial UTF-8 sequence and the unterminated final frame.
          parser.end();
          reader.releaseLock();
        }
        const outcome = parser.outcome;
        if (outcome.providerRequestId) providerRequestId = outcome.providerRequestId;
        if (outcome.model) actualProviderModel = outcome.model;
        if (outcome.upstreamProvider) upstreamProvider = outcome.upstreamProvider;
        if (outcome.usage) usage = {
          ...(outcome.usage as LLMUsage),
          provider_request_id: providerRequestId,
          actual_model: actualProviderModel,
          latency_ms: Math.max(0, Date.now() - startedAt),
          ttft_ms: ttftMs,
          upstream_provider: upstreamProvider,
        };
      };
      let providerRequestId: string | undefined;
      /** Hosts that produced nothing, so a retry is asked to use another one. */
      const exhaustedProviders: string[] = [];
      const recordAttemptUsage = async () => {
        if (!usage) return;
        await recordUsageEvent({ userId: account.id, conversationId, providerId: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, rpEngineId: engineId, responseLength, fundingSource, kind: action === "send" ? "chat" : action, taskRoute: "rp_generation", usage });
      };
      /** Everything known about why a stream produced no prose. */
      const emptyDiagnostic = () => {
        const outcome = parser.outcome;
        return {
          conversationId, provider: selection.providerId, model: selection.modelId,
          actualModel: actualProviderModel, upstreamProvider,
          detail: [
            outcome.error ? `upstream error: ${outcome.error.message}` : "",
            outcome.finishReason ? `finish_reason=${outcome.finishReason}` : "",
            outcome.nativeFinishReason ? `native_finish_reason=${outcome.nativeFinishReason}` : "",
            outcome.reasoningSeen ? "reasoning tokens only" : "",
            outcome.malformedFrames ? `malformed_frames=${outcome.malformedFrames}` : "",
            outcome.doneSeen ? "" : "stream ended without [DONE]",
          ].filter(Boolean).join("; ") || "no content and no reason given",
        };
      };
      try {
        await consume(upstream,requestStartedAt);
        // An error the stream reported about itself is that error, not silence.
        // It is classified and thrown so the reader gets the right sentence and
        // the retry policy gets the right answer about whether to try again.
        if (!parser.outcome.text.trim() && parser.outcome.error) {
          const streamError = parser.outcome.error;
          throw new ProviderError(classifyProviderFailure(streamError.code ?? 502, streamError.message), {
            ...emptyDiagnostic(), attempt: 1, status: streamError.code,
          });
        }
        if (!parser.outcome.text.trim() && parser.outcome.finishReason === "content_filter") {
          // A filtered generation is not a blip, and retrying it produces the
          // same refusal. The reader is told something true and specific.
          throw new ProviderError("content_filtered", { ...emptyDiagnostic(), attempt: 1 });
        }
        if (!parser.outcome.text.trim()) {
          // Some routed providers occasionally finish a successful HTTP stream
          // without text. Account for that attempt, then transparently retry
          // once so the user does not have to delete and resend their turn.
          //
          // The guard is deliberately "no visible text at all". A generation
          // that already streamed prose is never retried: appending a second,
          // independent continuation on top of it would produce a doubled or
          // self-contradicting reply, which is a worse failure than the one it
          // would be papering over.
          await recordAttemptUsage();
          if (upstreamProvider) exhaustedProviders.push(upstreamProvider);
          const spentOnReasoning = parser.outcome.reasoningSeen || truncatedByLength(parser.outcome);
          retried = true;
          usage = null; providerRequestId = undefined; upstreamProvider = undefined; ttftMs = undefined;
          parser.reset();
          actualProviderModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
          const retryStartedAt = Date.now();
          // The retry is DIFFERENT from the attempt that failed, which is the
          // point. It avoids the host that produced nothing, and if the silence
          // looked like an envelope spent on reasoning it asks for none.
          const retry = await streamWriterCompletion(selection,completionMessages,writerFunding,{
            ...completionOptions,
            excludeProviders: exhaustedProviders,
            /*
             * "Asks for none" now actually asks for none.
             *
             * This used to pass `false`, which OMITS the `reasoning` parameter
             * and therefore accepts whatever the endpoint does by default — on
             * a hybrid reasoning model, reasoning. So the retry after a
             * generation that spent its entire envelope thinking and returned
             * no prose asked for exactly the same thing again, and could burn
             * a second envelope the same way. `"off"` states it, and is only
             * sent to an endpoint that accepts the parameter at all.
             */
            ...(spentOnReasoning && capabilities.thinking ? { thinking: "off" as const } : {}),
          });
          await consume(retry,retryStartedAt);
        }
        const assistant = parser.outcome.text;
        if (!assistant.trim()) throw new ProviderError(parser.outcome.finishReason === "content_filter" ? "content_filtered" : "empty_response", { ...emptyDiagnostic(), attempt: 2 });
        const memoryIds = memories.map((memory) => memory.id);
        const arcIds = arcs.map((arc) => arc.id);
        /*
         * What this reply was written from, recorded with the reply.
         *
         * The memory and arc ids were already stored and were already the only
         * honest answer to "what did it recall". They are not the whole
         * question the reader is asking, which is "what story context did you
         * use" — and the transcript window, the curated canon, the scene and
         * the rolling summary are the rest of it. None of them can be
         * reconstructed afterwards: the window moves, canon is re-curated, the
         * summary is overwritten on the next consolidation. Recorded now or not
         * at all.
         *
         * It deliberately holds IDS AND COUNTS, never text. The inspector
         * resolves them against the reader's own rows at read time, which is
         * what keeps a creator's private definition out of it — there is no
         * field here a prompt could leak through.
         */
        /*
         * The exact transcript turns this generation was handed.
         *
         * `fitted.messages` is what survived budgeting, taken from the tail of
         * `history`, so the same slice of `history` names them — with the
         * revision each turn carried at the time. Ids alone were never enough:
         * the inline editor rewrites message content in place, and selecting a
         * different option replaces it, so an id would resolve to whatever that
         * turn says today rather than what this writer actually read.
         */
        const suppliedTranscript = history.slice(Math.max(0, history.length - fitted.messages.length));
        const generationRecord = {
          action,
          memoryVersions: memories.map((memory) => ({ id: memory.id, v: memory.contentVersion ?? 1 })),
          transcriptVersions: suppliedTranscript.map((message) => ({ id: message.id, v: message.contentVersion ?? 1 })),
          arcIds, canonIds: coreCanon.map((entry) => entry.id),
          sceneStateId: sceneState?.id ?? null,
          retrievalRunId: retrievalRunId || null,
          transcriptMessages: fitted.messages.length,
          transcriptTokens: fitted.plan.promptTokens,
          transcriptTrimmed: fitted.dropped ?? 0,
          summaryUsed: Boolean(currentSummary.trim()),
          summaryCharacters: currentSummary.length,
          continuityPlacement: placement,
        };

        const contextProvenance = {
          version: 1 as const,
          transcript: {
            messages: fitted.messages.length,
            firstMessageId: history[Math.max(0, history.length - fitted.messages.length)]?.id ?? null,
            lastMessageId: history.at(-1)?.id ?? null,
            estimatedTokens: fitted.plan.promptTokens,
            trimmedToFit: fitted.dropped ?? 0,
          },
          canonIds: coreCanon.map((entry) => entry.id),
          sceneStateId: sceneState?.id ?? null,
          summary: { used: Boolean(currentSummary.trim()), characters: currentSummary.length },
          retrievalRunId: retrievalRunId || null,
          continuityPlacement: placement,
        };

        /*
         * WHEN THE READER IS TOLD THE REPLY IS FINISHED.
         *
         * A send or a continue may still announce completion before the write,
         * because its variant list is known in advance: it is exactly one
         * element, the text just streamed. Announcing early is what stopped the
         * finished reply from sitting on screen with its controls hidden while
         * two database round trips finished.
         *
         * A REGENERATION CANNOT DO THAT, and doing it anyway was the second
         * half of this sprint's variant bug. Its variant index is not knowable
         * until the row is read and locked, because another regeneration of the
         * same reply may have appended one in the meantime. Computing it from a
         * `variants` array read tens of seconds earlier is how two attempts
         * both claimed index 1 — the later UPDATE dropping the earlier's text,
         * and the later `INSERT … ON CONFLICT DO NOTHING` writing no provenance
         * at all while reporting success.
         *
         * So the append is one locked transaction and its answer is what the
         * client is told. See src/lib/regeneration.ts.
         */
        /*
         * What the client is told if the write does not happen.
         *
         * The database's own answer, which for a regeneration whose transaction
         * rolled back is the target exactly as it was. Announcing a one-element
         * list there would describe a row that does not exist; the reader is
         * separately told to reload, and this way the variant picker they see
         * until they do matches what is actually stored.
         */
        let variants: string[] = regenerateTarget ? regenerateTarget.variants : [assistant];
        let selectedVariant = regenerateTarget ? regenerateTarget.selectedVariant : 0;
        let persistenceFailed = false;

        const outcome = parser.outcome;
        const truncated = truncatedByLength(outcome);
        /*
         * DID THE GENERATION END, OR DID THE CONNECTION?
         *
         * Prose arriving is not evidence that a reply finished. A transport that
         * dies mid-sentence produces exactly the same thing as one that ended on
         * purpose, minus any `finish_reason`, `native_finish_reason` or
         * `[DONE]` — and with nothing distinguishing them, an interrupted reply
         * was stored, announced and logged as an ordinary success. The reader
         * saw a sentence stop halfway and no explanation existed anywhere.
         *
         * `streamEnding` refuses to claim a completion without terminal
         * evidence. What follows from an interruption is deliberately narrow:
         *
         *   THE TEXT IS KEPT. Every byte that arrived is real, was produced, and
         *   was billed. Discarding it would lose the reader's scene and change
         *   nothing about the cost.
         *
         *   NOTHING IS GENERATED TO COVER IT. Silently appending a second model
         *   turn is the behaviour this sprint must not have: it would double a
         *   reply on a guess and bill for that too.
         *
         *   IT IS NOT CALLED A SUCCESS. The client is told `incomplete`, the
         *   diagnostic records `incomplete_transport`, and accounting is left
         *   exactly as accurate as it was — the tokens happened.
         */
        const ending = streamEnding(outcome);
        const interrupted = ending.kind === "interrupted";
        timeline.mark("stream-complete");
        at("stream_complete");
        /**
         * The completion event, with whatever is known when it is sent.
         *
         * `truncated` and `incomplete` are two different statements and both are
         * made. Truncated means the generation ended, deliberately, at a ceiling
         * we set; incomplete means nothing said it ended at all. Neither causes
         * another turn to be generated: that is the reader's decision, and
         * Continue is already the control for it.
         */
        const announce = () => send({
          type: "done", id: assistantId, userMessageId, variants, selectedVariant,
          ...(truncated ? { truncated: true } : {}),
          ...(interrupted ? { incomplete: true, interruptedBy: ending.cause } : {}),
          ...(isAdminAccount(account) ? { memoriesUsed: memoryIds, arcsUsed: arcIds, usage, finishReason: outcome.finishReason } : {}),
        });
        // A send or a continue announces BEFORE the write, because its variant
        // list is already known — one element, the text just streamed — and
        // holding the event until two database round trips finished left the
        // finished reply on screen with its controls hidden, which read as a
        // freeze. A regeneration cannot: see above.
        if (!regenerateTarget) announce();

        try {
          const commit = await asUser(account.id, (client) => regenerateTarget
            ? commitRegeneratedVariant(client, {
              messageId: assistantId, userId: account.id, conversationId, text: assistant,
              memoryIds, arcIds, contextProvenance, generation: generationRecord,
            })
            : commitNewAssistantMessage(client, {
              messageId: assistantId, userId: account.id, conversationId, text: assistant,
              memoryIds, arcIds, contextProvenance, generation: generationRecord,
            }));
          if (!commit.ok) {
            // The reply the regeneration targeted is gone — deleted from another
            // tab while the model was writing. There is nothing to append to.
            diagnostic.detail = `regeneration target ${commit.reason}`;
            throw new ProviderError("unknown", { conversationId, detail: `regeneration target ${commit.reason}` });
          }
          variants = commit.variants;
          selectedVariant = commit.variantIndex;
          diagnostic.variantIndex = commit.variantIndex;
        } catch (error) {
          persistenceFailed = true;
          /*
           * A variant whose provenance could not be written is not stored at
           * all: `commitRegeneratedVariant` throws and the transaction rolls
           * back, message row included. That is deliberate — a stored reply
           * carrying some other generation's provenance would make the Context
           * inspector confidently wrong, which is worse than the failure.
           */
          if (error instanceof ProvenanceConflictError) {
            diagnostic.reason = "variant_conflict";
            diagnostic.variantIndex = error.variantIndex;
            console.error("[generation] variant abandoned: provenance conflict", JSON.stringify({
              conversationId, action, messageId: error.messageId, variantIndex: error.variantIndex,
            }));
          }
          console.error("Reply persistence failed", error);
        }

        if (regenerateTarget) announce();
        diagnostic.finishReason = outcome.finishReason;
        diagnostic.nativeFinishReason = outcome.nativeFinishReason;
        diagnostic.truncated = truncated;
        diagnostic.streamDone = outcome.doneSeen;
        diagnostic.usageSeen = Boolean(outcome.usage);
        diagnostic.malformedFrames = outcome.malformedFrames;
        diagnostic.replyCharacters = assistant.length;
        diagnostic.retried = retried;
        diagnostic.ttftMs = ttftMs ?? null;
        diagnostic.upstreamProvider = upstreamProvider;
        diagnostic.requestId = providerRequestId;
        diagnostic.promptTokens = (usage as LLMUsage | null)?.prompt_tokens ?? null;
        diagnostic.completionTokens = (usage as LLMUsage | null)?.completion_tokens ?? null;
        diagnostic.reasoningTokens = ((usage as LLMUsage | null)?.completion_tokens_details?.reasoning_tokens as number | undefined) ?? null;
        diagnostic.latencyMs = (usage as LLMUsage | null)?.latency_ms ?? null;
        if (interrupted) {
          diagnostic.incomplete = true;
          diagnostic.detail = ending.cause === "upstream_error"
            ? `stream interrupted: ${outcome.error?.message ?? "upstream reported a fault after partial text"}`
            : "stream ended without finish_reason or [DONE]";
        }

        if (persistenceFailed) {
          // The reader was told the reply finished, so a failed write has to be
          // reported rather than swallowed: the text on their screen would
          // otherwise disappear on the next reload with no explanation.
          send({ type: "error", error: "That reply could not be saved. Reload the chat before continuing." });
        }
        at("persisted");
        timeline.mark("persisted");
        /*
         * The timeline, emitted once the reply is on screen and saved.
         *
         * This is the artifact that answers "where did the minute go" — every
         * stage from auth to persistence with its own duration, and the slowest
         * one named. Stage names and numbers only; see request-timing.ts.
         */
        logTimeline(timeline, {
          conversationId, action,
          provider: selection.providerId, model: selection.modelId,
          upstreamProvider: upstreamProvider ?? null,
          ttftMs: ttftMs ?? null,
          promptTokens: (usage as LLMUsage | null)?.prompt_tokens ?? null,
          completionTokens: (usage as LLMUsage | null)?.completion_tokens ?? null,
        });

        // Accounting must not hold the accepted-message event (and therefore
        // the post-stream controls) behind another database round trip.
        void recordAttemptUsage().catch((error)=>console.error("Usage accounting failed",error));
        /*
         * The generation ran and produced a reply, so the free-tier slot is
         * spent — the platform's upstream allowance was genuinely consumed and
         * no ledger entry can give that back.
         *
         * Health is recorded from the same facts the reply already carries:
         * time to first token, and how many tokens arrived over how long. That
         * is what lets a free route be reported as slow without anybody running
         * a separate probe against it.
         */
        void settleFunding(true).catch((error) => console.error("Free-tier settlement failed", error));
        /*
         * Route health is "did this route deliver a whole reply", so an
         * interruption is not a success for it — the latency numbers describe a
         * generation that did not finish, and averaging them in would make a
         * route that cuts replies off look healthy.
         */
        void recordRouteOutcome(interrupted
          ? { modelId: selection.modelId, ok: false, capacity: false }
          : {
            modelId: selection.modelId, ok: true,
            ttftMs: ttftMs ?? null,
            outputTokens: (usage as LLMUsage | null)?.completion_tokens ?? null,
            generationMs: (usage as LLMUsage | null)?.latency_ms ?? null,
          });
        /*
         * An interruption is not a normal completion, and saying it is was the
         * whole defect. It is not a total failure either — the text is stored
         * and shown, the tokens are accounted for — so it is recorded as failed
         * with a reason that says exactly which of the two it is.
         */
        finish(
          persistenceFailed || interrupted ? "failed" : "ok",
          persistenceFailed ? "persistence_failure" : interrupted ? "incomplete_transport" : undefined,
        );
        controller.close();
        void (async () => {
          // Scene State first: consolidation stamps the memories it creates
          // with whatever the scene ledger knows by then. A failure in either
          // is logged and dropped — the reply has already been delivered.
          await maybeUpdateSceneState(account.id,conversationId);
          if (regenerateTarget) return;
          await maybeConsolidate(account.id,conversationId);
          await maybeCurateCanon(account.id,conversationId);
          await maybeBackfillMemoryEmbeddings(account.id,conversationId);
        })().catch((error) => console.error("Memory maintenance failed",error));
      } catch (error) {
        const streamed = parser.outcome.text;
        logProviderDiagnostic("rp generation failed mid-stream", error instanceof ProviderError
          ? error.withDiagnostic({ conversationId, provider: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, upstreamProvider })
          : error);
        /*
         * WHETHER THE SLOT COMES BACK DEPENDS ON WHETHER A MODEL RAN.
         *
         * A failure with no text is a request that never produced a generation,
         * and the reader gets their allowance back. A failure AFTER prose has
         * streamed is not refundable: the tokens were produced and the
         * platform's allowance was spent, and crediting it back would make the
         * ledger disagree with what OpenRouter has already counted.
         */
        void settleFunding(Boolean(streamed.trim())).catch((settleError) => console.error("Free-tier settlement failed", settleError));
        void recordRouteOutcome({
          modelId: selection.modelId, ok: false,
          capacity: error instanceof ProviderError && error.category === "rate_limited",
        });
        /*
         * The failure, recorded in the vocabulary an operator can act on.
         *
         * "Something went wrong while generating the response" is the reader's
         * sentence and it is deliberately vague. It was ALSO everything the
         * operator got, which is what made a Regenerate that failed most of the
         * time undiagnosable. These fields are the answer to "which stage, and
         * why" for the same turn.
         */
        const failed = parser.outcome;
        diagnostic.finishReason = failed.finishReason;
        diagnostic.nativeFinishReason = failed.nativeFinishReason;
        diagnostic.streamDone = failed.doneSeen;
        diagnostic.usageSeen = Boolean(failed.usage);
        diagnostic.malformedFrames = failed.malformedFrames;
        diagnostic.replyCharacters = streamed.length;
        diagnostic.retried = retried;
        diagnostic.ttftMs = ttftMs ?? null;
        diagnostic.upstreamProvider = upstreamProvider;
        diagnostic.requestId = providerRequestId;
        if (error instanceof ProviderError) {
          diagnostic.category = error.category;
          diagnostic.status = error.diagnostic.status;
          diagnostic.attempt = error.diagnostic.attempt;
          diagnostic.detail = error.diagnostic.detail;
        } else {
          diagnostic.detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        }
        finish("failed", error instanceof ProviderError
          ? (failed.malformedFrames && error.category === "empty_response" ? "stream_parse_failure" : reasonForCategory(error.category))
          : request.signal.aborted ? "client_aborted" : "unknown");
        send({ type: "error", error: writerErrorMessage(error, writerFunding) });
        controller.close();
      }
    },
  });
  return new Response(responseStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
