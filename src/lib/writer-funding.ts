import { query } from "./db";
import { ByokError, preflightWriterFunding, resolveWriterFunding, type InferenceFunding } from "./byok";
import { freeTierConfig, releaseFreeReservation, reserveFreeGeneration, spendFreeReservation, type FreeReservation, type FreeTierRefusal } from "./free-tier";
import { fundedWriterAllowed, type SpendRefusal } from "./spend-guards";
import { isFreeModel, resolveModel } from "./provider";
import type { ModelSelection } from "./llm";

/**
 * WHO PAYS FOR THIS GENERATION, DECIDED ONCE, IN ONE PLACE.
 *
 * There are now four answers and they were previously two. The chat route must
 * not learn to tell them apart itself: funding decides which credential is
 * sent, which ledger is debited, what a failure has to give back, and what a
 * refusal says to the reader — and spreading those four consequences across a
 * seven-hundred-line route is how one of them ends up wrong.
 *
 *   byok             The reader's own OpenRouter account. Afterglow pays
 *                    nothing, including for a `:free` route — a free model on
 *                    somebody's own key draws on THEIR quota, and it would be
 *                    dishonest to spend Afterglow's shared pool on a reader who
 *                    brought their own.
 *   shared_free      The platform account's free-model quota, reserved from the
 *                    shared daily pool before the request leaves.
 *   platform_funded  Afterglow paying real money for an ultra-cheap writer,
 *                    behind an explicit route allowlist and a dollar budget.
 *   afterglow        Ordinary paid inference for a paid model, exactly as
 *                    before this sprint. Unchanged.
 *
 * BACKGROUND WORK IS NOT IN THIS FILE AND MUST NOT BE. Memory consolidation,
 * canon and Scene State stay Afterglow-funded regardless of a reader's writer
 * funding, because they are Afterglow's own maintenance rather than the
 * reader's generation. That is unchanged, and `byok.ts` already enforces it
 * structurally: only `rp_generation` can reach a user credential at all.
 *
 * THE LADDER NEVER SWAPS A WRITER BEHIND SOMEBODY'S BACK. When free capacity is
 * gone, the default is to REFUSE with the remedies named — wait for the reset,
 * connect a key, use a paid model — and let the reader choose. A deployment can
 * set `FREE_FUNDED_FALLBACK_MODE=auto` to have Afterglow pick the funded writer
 * itself, and even then the substitution is reported in the response and
 * written to the usage ledger as `platform_funded`. There is no configuration
 * in which a reader's model changes and nothing says so.
 */

export type WriterFundingKind = "afterglow" | "byok" | "shared_free" | "platform_funded";

export type WriterFundingPlan =
  | { kind: "afterglow" | "byok"; selection: ModelSelection }
  | { kind: "shared_free" | "platform_funded"; selection: ModelSelection; reservation: FreeReservation; substituted: boolean };

export type WriterFundingRefusal = {
  kind: "refused";
  reason: FreeTierRefusal | SpendRefusal;
  /** The reader-facing sentence. Never names infrastructure or a provider. */
  message: string;
  /** What the client may offer. Order is the order a reader should see. */
  remedies: Array<"wait_for_reset" | "connect_byok" | "choose_paid_model" | "use_funded_model">;
  /** Present when a funded writer is available and the reader must opt in. */
  fundedModelId?: string;
  /** UTC midnight: when the shared pool comes back. */
  resetsAt: string;
};

export type WriterFundingOutcome = WriterFundingPlan | WriterFundingRefusal;

/** Whether Afterglow may choose the funded writer itself, or must ask first. */
export function fundedFallbackMode(): "ask" | "auto" {
  return process.env.FREE_FUNDED_FALLBACK_MODE?.trim() === "auto" ? "auto" : "ask";
}

function nextUtcMidnight(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/**
 * The reader's sentences.
 *
 * Written from the reader's side of the transaction, which is the only side
 * they can act on. "Today's shared free capacity has been used" is true and
 * actionable; "the platform pool is exhausted" is the same fact told in the
 * platform's language, and an account balance is never mentioned at all.
 */
const refusalMessages: Record<FreeTierRefusal | SpendRefusal, string> = {
  disabled: "Free models are not available on this deployment.",
  pool_exhausted: "Today's shared free capacity has been used. It resets at midnight UTC.",
  user_cap_reached: "You have used your free generations for today. They reset at midnight UTC.",
  account_too_new: "Free generations become available a short while after signing up.",
  route_not_allowed: "That model is not available on the free tier.",
  unbounded_price: "That model is not available on the free tier.",
  daily_budget_reached: "Today's shared free capacity has been used. It resets at midnight UTC.",
  user_budget_reached: "You have used your free generations for today. They reset at midnight UTC.",
};

async function accountCreatedAt(userId: string) {
  try {
    const result = await query<{ created_at: string }>("SELECT created_at FROM profiles WHERE id=$1", [userId]);
    return result.rows[0]?.created_at ?? null;
  } catch {
    /*
     * An unreadable profile is not evidence of a fresh account.
     *
     * Returning null skips the age check rather than refusing, because the
     * check exists to make scripted signups unrewarding and not to be a second
     * authentication gate. Failing it closed would lock out real readers over a
     * transient database blip.
     */
    return null;
  }
}

/**
 * Decide funding for one roleplay generation.
 *
 * Ordered so that the cheapest-to-answer questions come first and so that a
 * reader who brought their own key never touches Afterglow's ledger.
 */
export async function planWriterFunding(input: {
  userId: string;
  selection: ModelSelection;
  now?: Date;
}): Promise<WriterFundingOutcome> {
  const now = input.now ?? new Date();
  const resetsAt = nextUtcMidnight(now);

  /*
   * BYOK FIRST, AND IT COVERS FREE MODELS TOO.
   *
   * This is section M's whole point. A reader who has connected their own
   * OpenRouter key and selected a `:free` route is spending THEIR free quota,
   * not Afterglow's — so no reservation is taken, no pool is debited, and the
   * generation is written to the ledger as `byok`. Charging the shared pool for
   * a reader who supplied their own key would exhaust it for everybody else and
   * report a cost that nobody paid.
   */
  const intent = await preflightWriterFunding(input.userId, "rp_generation", input.selection);
  if (intent.type === "byok") return { kind: "byok", selection: input.selection };

  if (!isFreeModel(input.selection.modelId)) return { kind: "afterglow", selection: input.selection };

  const config = freeTierConfig();
  if (!config.enabled) {
    return { kind: "refused", reason: "disabled", message: refusalMessages.disabled, remedies: ["choose_paid_model"], resetsAt };
  }

  const created = await accountCreatedAt(input.userId);
  const shared = await reserveFreeGeneration({
    userId: input.userId, modelId: input.selection.modelId,
    funding: "shared_free", accountCreatedAt: created, now,
  });
  if (shared.ok) return { kind: "shared_free", selection: input.selection, reservation: shared.reservation, substituted: false };

  /*
   * THE READER'S OWN CAP IS THE END OF THE LADDER.
   *
   * A funded fallback exists to survive the PLATFORM running out of free
   * capacity. Using it to serve somebody who has spent their own daily
   * allowance would convert the per-user cap into a suggestion and hand the
   * heaviest user the funded budget as well, which is exactly backwards.
   */
  if (shared.reason !== "pool_exhausted") {
    return {
      kind: "refused", reason: shared.reason, message: refusalMessages[shared.reason],
      remedies: shared.reason === "user_cap_reached" ? ["wait_for_reset", "connect_byok", "choose_paid_model"] : ["connect_byok", "choose_paid_model"],
      resetsAt,
    };
  }

  const funded = await planFundedFallback({ userId: input.userId, now, resetsAt, created });
  return funded;
}

async function planFundedFallback(input: { userId: string; now: Date; resetsAt: string; created: string | null }): Promise<WriterFundingOutcome> {
  const config = freeTierConfig();
  const refuse = (reason: FreeTierRefusal | SpendRefusal): WriterFundingRefusal => ({
    kind: "refused", reason, message: refusalMessages[reason],
    remedies: ["wait_for_reset", "connect_byok", "choose_paid_model"], resetsAt: input.resetsAt,
  });

  const fundedModelId = config.fundedModelId;
  if (!fundedModelId || config.fundedDailyPool <= 0) return refuse("pool_exhausted");
  // A funded model that is not in this deployment's enabled catalogue is a
  // configuration mistake, and the reader gets the ordinary "capacity used"
  // answer rather than an error about a variable they cannot see.
  if (!resolveModel("openrouter", fundedModelId)) {
    console.error("[free-tier] FREE_FUNDED_FALLBACK_MODEL does not name an enabled model", fundedModelId);
    return refuse("pool_exhausted");
  }

  const guard = await fundedWriterAllowed({ userId: input.userId, modelId: fundedModelId, now: input.now });
  if (!guard.allowed) return refuse(guard.reason);

  /*
   * ASK, UNLESS THE DEPLOYMENT HAS SAID OTHERWISE.
   *
   * The default answer is a refusal that OFFERS the funded writer rather than
   * one that uses it. A reader's writer is part of their story, and swapping it
   * because a shared pool ran dry is a change they should get to make. The
   * reservation is deliberately NOT taken here: holding a funded slot against a
   * question nobody has answered would let a crawler drain the funded budget by
   * asking.
   */
  if (fundedFallbackMode() === "ask") {
    return {
      kind: "refused", reason: "pool_exhausted", message: refusalMessages.pool_exhausted,
      remedies: ["use_funded_model", "wait_for_reset", "connect_byok", "choose_paid_model"],
      fundedModelId, resetsAt: input.resetsAt,
    };
  }

  const reservation = await reserveFreeGeneration({
    userId: input.userId, modelId: fundedModelId,
    funding: "platform_funded", accountCreatedAt: input.created, now: input.now,
  });
  if (!reservation.ok) return refuse(reservation.reason);
  return {
    kind: "platform_funded",
    selection: { providerId: "openrouter", modelId: fundedModelId },
    reservation: reservation.reservation,
    // The writer changed. Said out loud, in the response and in the ledger.
    substituted: true,
  };
}

/**
 * Funding for a generation the reader has explicitly asked Afterglow to fund.
 *
 * The other half of `ask` mode: the client came back naming the funded model,
 * so the guards run again — the budget may have gone in the meantime — and a
 * slot is taken. Separate from `planWriterFunding` because consent is a
 * different input, not a different configuration.
 */
export async function acceptFundedFallback(input: { userId: string; modelId: string; now?: Date }): Promise<WriterFundingOutcome> {
  const now = input.now ?? new Date();
  const resetsAt = nextUtcMidnight(now);
  const config = freeTierConfig();
  if (!config.enabled || config.fundedModelId !== input.modelId) {
    return { kind: "refused", reason: "route_not_allowed", message: refusalMessages.route_not_allowed, remedies: ["choose_paid_model"], resetsAt };
  }
  const guard = await fundedWriterAllowed({ userId: input.userId, modelId: input.modelId, now });
  if (!guard.allowed) {
    return { kind: "refused", reason: guard.reason, message: refusalMessages[guard.reason], remedies: ["wait_for_reset", "connect_byok", "choose_paid_model"], resetsAt };
  }
  const reservation = await reserveFreeGeneration({
    userId: input.userId, modelId: input.modelId, funding: "platform_funded",
    accountCreatedAt: await accountCreatedAt(input.userId), now,
  });
  if (!reservation.ok) {
    return { kind: "refused", reason: reservation.reason, message: refusalMessages[reservation.reason], remedies: ["wait_for_reset", "connect_byok", "choose_paid_model"], resetsAt };
  }
  return { kind: "platform_funded", selection: { providerId: "openrouter", modelId: input.modelId }, reservation: reservation.reservation, substituted: true };
}

/** The credential this plan authenticates with, resolved as late as possible. */
export async function credentialFor(userId: string, plan: WriterFundingPlan): Promise<InferenceFunding> {
  if (plan.kind !== "byok") return { type: "afterglow" };
  return resolveWriterFunding(userId, "rp_generation", plan.selection);
}

/**
 * Settle whatever the plan reserved.
 *
 * `ran` means inference happened and produced tokens — the slot is spent and is
 * not coming back, because the platform's upstream allowance was genuinely
 * consumed. Anything else releases it: the reader gets their allowance back for
 * a request that never reached a model.
 *
 * AFTERGLOW'S LEDGER IS THE ONLY THING BEING RETURNED. OpenRouter counts a
 * failed free-model attempt against the platform's daily allowance whatever
 * this function does, which is why the routing layer treats an upstream 429 as
 * authoritative rather than trusting these numbers to predict capacity.
 */
export async function settleWriterFunding(plan: WriterFundingOutcome, ran: boolean) {
  if (plan.kind !== "shared_free" && plan.kind !== "platform_funded") return;
  try {
    await (ran ? spendFreeReservation(plan.reservation) : releaseFreeReservation(plan.reservation));
  } catch (error) {
    // A settlement that cannot be written leaves the reservation open, and the
    // sweep in free-tier.ts releases it. Losing a reply over an accounting row
    // would be the wrong trade.
    console.warn("[free-tier] could not settle a reservation", plan.reservation.id, error instanceof Error ? error.message : error);
  }
}

/** The `funding_source` this plan writes to the usage ledger. */
export function fundingSourceFor(plan: WriterFundingPlan): WriterFundingKind {
  return plan.kind;
}

export { ByokError };
