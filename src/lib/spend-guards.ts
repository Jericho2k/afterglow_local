import { query } from "./db";
import { approvedProviderPool, costPolicyFor, isFreeModel, modelCapabilities } from "./provider";
import { utcDay } from "./free-tier";

/**
 * HARD LIMITS ON WHAT AFTERGLOW WILL PAY FOR, ENFORCED BEFORE THE REQUEST.
 *
 * The free tier's failure mode is not "readers run out of free messages". It is
 * "free capacity ran out at two in the morning, every request fell through to a
 * paid writer, and nobody found out until the invoice". Every mechanism in this
 * file exists to make that specific sequence impossible.
 *
 * FOUR GUARDS, and they are deliberately independent rather than one clever
 * number, because they fail in different directions:
 *
 *   THE DAILY BUDGET bounds total platform-funded writer spend per UTC day. It
 *   is the backstop that holds even if every other guard is misconfigured.
 *
 *   THE PER-USER CAP bounds what one account can cost in a day, so a single
 *   automated client cannot consume the budget before anybody else wakes up.
 *
 *   THE ROUTE ALLOWLIST names which models platform funding may reach at all.
 *   This is the one that stops "the cheap route is unavailable" from quietly
 *   becoming "so we used the premium one".
 *
 *   THE PRICE GUARD is the per-model `costCeiling` already sent to OpenRouter
 *   as `max_price`. It is checked here too, because a model with no ceiling has
 *   no upper bound on what an endpoint may charge for it and therefore has no
 *   business being a funded fallback.
 *
 * WHAT HAPPENS WHEN A GUARD TRIPS. The request is refused honestly, or another
 * explicitly approved free-tier route is used. It is never satisfied by
 * reaching for a dearer model: silently converting unlimited free usage into
 * paid platform spend is the harm, and a guard that resolves itself by spending
 * more money is not a guard.
 */

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export type SpendGuardConfig = {
  /** USD of platform-funded WRITER spend allowed per UTC day. */
  dailyBudgetUsd: number;
  /** USD of platform-funded writer spend allowed per account per UTC day. */
  userDailyBudgetUsd: number;
  /**
   * Catalogue ids platform funding may reach.
   *
   * Empty means "nothing beyond the curated free routes", which is the
   * default: a deployment that has not named a funded model does not have one.
   */
  fundedModelAllowlist: string[];
};

export function spendGuardConfig(): SpendGuardConfig {
  return {
    dailyBudgetUsd: positiveNumber(process.env.PLATFORM_WRITER_DAILY_BUDGET_USD, 0),
    userDailyBudgetUsd: positiveNumber(process.env.PLATFORM_WRITER_USER_DAILY_BUDGET_USD, 0),
    fundedModelAllowlist: (process.env.PLATFORM_FUNDED_MODELS || "")
      .split(",").map((value) => value.trim()).filter(Boolean),
  };
}

export type SpendRefusal =
  /** This model is not on the funded route allowlist. */
  | "route_not_allowed"
  /** This model declares no price ceiling, so its cost is unbounded. */
  | "unbounded_price"
  /** The platform has spent its budget for today. */
  | "daily_budget_reached"
  /** This account has spent its share of the budget for today. */
  | "user_budget_reached";

/**
 * Whether Afterglow may fund a writer generation on this model, for this user.
 *
 * The two static checks come first and cost no database round trip, because
 * "this model is not allowed to be funded at all" is a configuration answer and
 * should not depend on how much has been spent today.
 */
export async function fundedWriterAllowed(input: { userId: string; modelId: string; now?: Date }): Promise<{ allowed: true } | { allowed: false; reason: SpendRefusal }> {
  const config = spendGuardConfig();
  /*
   * A CURATED FREE ROUTE NEEDS NO BUDGET. It costs nothing, so a dollar budget
   * has nothing to say about it; what bounds it is the free-tier pool in
   * src/lib/free-tier.ts. Sending it through here would mean an unset budget
   * disabled the free tier, which is precisely backwards.
   */
  if (isFreeModel(input.modelId)) return { allowed: true };
  if (!config.fundedModelAllowlist.includes(input.modelId)) return { allowed: false, reason: "route_not_allowed" };
  /*
   * NO CEILING, NO FUNDING.
   *
   * A model with no `costCeiling` can be served by whichever endpoint
   * OpenRouter picks, at whatever that endpoint charges. That is an acceptable
   * risk for a writer a reader chose and is paying for through a subscription;
   * it is not an acceptable risk for a writer Afterglow reached for
   * automatically because something else was unavailable.
   */
  if (!modelCapabilities("openrouter", input.modelId).costCeiling) return { allowed: false, reason: "unbounded_price" };

  const day = utcDay(input.now ?? new Date());
  const spent = await fundedSpendToday(day, input.userId);
  if (config.dailyBudgetUsd > 0 && spent.platformUsd >= config.dailyBudgetUsd) return { allowed: false, reason: "daily_budget_reached" };
  if (config.userDailyBudgetUsd > 0 && spent.userUsd >= config.userDailyBudgetUsd) return { allowed: false, reason: "user_budget_reached" };
  return { allowed: true };
}

/**
 * Platform-funded writer spend so far today, in total and for one account.
 *
 * Read from the usage ledger rather than from a counter, because the ledger is
 * where the real charges land and a second counter would be a second thing to
 * be wrong. `funding_source='platform_funded'` is what makes this answerable at
 * all — it is the reason the free tier introduced that value instead of writing
 * these generations down as ordinary Afterglow spend.
 *
 * The figure LAGS by the generation currently in flight, which is correct for a
 * guard: it can overshoot a budget by at most the concurrent requests, and the
 * alternative — reserving dollars before knowing the token count — would refuse
 * readers on a guess.
 */
export async function fundedSpendToday(day: string, userId: string) {
  try {
    const result = await query<{ platform_usd: string | null; user_usd: string | null }>(
      `SELECT
         COALESCE(SUM(COALESCE(provider_cost_usd,estimated_cost_usd,0)),0) AS platform_usd,
         COALESCE(SUM(CASE WHEN user_id=$2 THEN COALESCE(provider_cost_usd,estimated_cost_usd,0) ELSE 0 END),0) AS user_usd
       FROM usage_events
       WHERE funding_source='platform_funded'
         AND task_route='rp_generation'
         AND created_at >= $1::date AND created_at < ($1::date + 1)`,
      [day, userId],
    );
    return {
      platformUsd: Number(result.rows[0]?.platform_usd ?? 0),
      userUsd: Number(result.rows[0]?.user_usd ?? 0),
    };
  } catch (error) {
    /*
     * A LEDGER THAT CANNOT BE READ MEANS NO FUNDED SPEND.
     *
     * The safe direction is unambiguous here and it is the opposite of the
     * usual one: an unreadable budget must not be treated as an unspent budget.
     * Returning infinity refuses the funded fallback and leaves the reader with
     * the free tier and the paid tiers, which is a smaller harm than an
     * unbounded night.
     */
    console.warn("[spend-guards] could not read funded spend; refusing funded fallback", error instanceof Error ? error.message : error);
    return { platformUsd: Number.POSITIVE_INFINITY, userUsd: Number.POSITIVE_INFINITY };
  }
}

/**
 * A one-line description of what is guarding one model, for the operator.
 *
 * Exported because the routing diagnostic renders it: a guard nobody can read
 * back is a guard nobody can trust, and "which endpoints may serve this, at
 * what ceiling, under what privacy floor" should be answerable without reading
 * the catalogue source.
 */
export function guardSummary(modelId: string) {
  const policy = costPolicyFor(modelId);
  return {
    modelId,
    free: isFreeModel(modelId),
    approvedProviders: approvedProviderPool(modelId),
    maxPrice: policy?.maxPrice ?? null,
    enforcedPool: policy?.only ?? null,
    dataPolicy: modelCapabilities("openrouter", modelId).dataPolicy ?? null,
    fundable: spendGuardConfig().fundedModelAllowlist.includes(modelId),
  };
}
