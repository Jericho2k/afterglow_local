import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
import { backgroundRoute, backgroundTasks } from "@/lib/background-routing";
import { resolveUsageRange, usageRangeFilter } from "@/lib/usage-range";

/**
 * WHERE DID THE BACKGROUND SAVING ACTUALLY COME FROM?
 *
 * Four things changed at once in this sprint, and each of them makes background
 * inference cheaper by a different mechanism:
 *
 *   A CHEAPER MODEL — the admin selector moved a job to a lower-priced route.
 *   FEWER CALLS     — the Scene Ledger skips static turns and no longer runs on
 *                     regenerated drafts.
 *   CACHE           — a stable prefix on a stable session, so repeated bytes are
 *                     billed at the cached-read rate.
 *   A SMALLER PROMPT — the extraction contract shrank by about four fifths.
 *
 * A single "spend is down 70%" figure mixes all four and cannot tell you which
 * to keep. Worse, it hides the one interaction that matters: a cheaper model
 * that made the ledger unreliable, or a skip rate achieved by skipping turns
 * that mattered, both look like wins in a total. So this report keeps them
 * apart and refuses to add them up.
 *
 * WHAT IT WILL NOT DO IS CLAIM A CACHE SAVING WE CANNOT SEE. `cachedTokens` is
 * whatever the provider reported in `usage.prompt_tokens_details.cached_tokens`
 * (or DeepSeek's own `prompt_cache_hit_tokens`). An endpoint that reports none
 * shows a ratio of null and says "not reported", never zero and never an
 * estimate — the offline prefix measurement in tests/memory-cacheability is a
 * CEILING, and a ceiling is not a bill.
 *
 * Admin-only and account-scoped, like the routing diagnostic beside it: an
 * administrator reads their own account's background spend, not the platform's.
 */

type Row = {
  usage_type: string;
  model: string;
  provider_id: string;
  upstream_provider: string | null;
  calls: string | number;
  prompt_tokens: string | number;
  cached_tokens: string | number;
  completion_tokens: string | number;
  provider_cost: string | number | null;
  estimated_cost: string | number | null;
  reported_cost_calls: string | number;
  latency_ms: string | number | null;
  routing_candidate: string | null;
  routing_source: string | null;
};

const number = (value: string | number | null | undefined) => (value == null ? 0 : Number(value));

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const range = resolveUsageRange(params);
  const { predicate, values } = usageRangeFilter(account.id, range);

  const payload = await asUser(account.id, async (client) => {
    /*
     * Grouped by ROUTE AND BY DECISION, not by model alone.
     *
     * Two weeks of consolidations on the same model mean different things if
     * one week ran because an administrator chose it and the other because an
     * environment variable was still set from an incident. `routing_candidate`
     * and `routing_source` are what make an A/B period identifiable after the
     * fact; without them the ledger records what ran and forgets why.
     */
    const usage = await client.query<Row>(
      `SELECT usage_type,
              model,
              provider_id,
              upstream_provider,
              COUNT(*)::int                                          AS calls,
              SUM(prompt_tokens)::bigint                             AS prompt_tokens,
              SUM(cache_hit_tokens)::bigint                          AS cached_tokens,
              SUM(completion_tokens)::bigint                         AS completion_tokens,
              SUM(provider_cost_usd)                                 AS provider_cost,
              SUM(estimated_cost_usd)                                AS estimated_cost,
              COUNT(provider_cost_usd)::int                          AS reported_cost_calls,
              AVG(latency_ms)                                        AS latency_ms,
              provider_metadata->'routing'->>'candidate'             AS routing_candidate,
              provider_metadata->'routing'->>'source'                AS routing_source
         FROM usage_events
        WHERE ${predicate}
          AND usage_type IN ('memory_consolidation','memory_curation','scene_state')
        GROUP BY usage_type, model, provider_id, upstream_provider, routing_candidate, routing_source
        ORDER BY usage_type, calls DESC`,
      values,
    );

    /*
     * THE SCENE LEDGER'S OWN NUMBERS, WHICH THE USAGE LEDGER CANNOT SUPPLY.
     *
     * A usage event exists only when a model ran, so counting them tells you
     * how many extractions happened and NOTHING about how many were avoided —
     * which is the whole point of the skip. The ledger table has both, because
     * a skipped turn still writes its row (carrying the previous values
     * forward) and stamps `extraction_model = 'skipped'`.
     *
     * "Eligible" therefore means "an accepted story advance that reached the
     * ledger": every normal reply and every Continue, and no regeneration,
     * because regenerations no longer produce a row at all.
     */
    const ledger = await client.query<{ extraction_model: string; status: string; rows: string | number }>(
      `SELECT extraction_model, status, COUNT(*)::int AS rows
         FROM conversation_scene_states
        WHERE user_id=$1
          ${range.from ? "AND created_at >= $2" : ""}
          ${range.to ? `AND created_at < $${range.from ? 3 : 2}` : ""}
        GROUP BY extraction_model, status`,
      [account.id, ...(range.from ? [range.from.toISOString()] : []), ...(range.to ? [range.to.toISOString()] : [])],
    );

    return { usage: usage.rows, ledger: ledger.rows };
  });

  const groups = payload.usage.map((row) => {
    const prompt = number(row.prompt_tokens);
    const cached = number(row.cached_tokens);
    const calls = number(row.calls);
    // Provider-reported cost only. An estimate is reported separately and
    // never silently substituted, because a cost comparison between two
    // candidates is worthless if one side is a guess from our own table.
    const reportedCalls = number(row.reported_cost_calls);
    const providerCost = row.provider_cost === null ? null : Number(row.provider_cost);
    return {
      task: row.usage_type,
      candidate: row.routing_candidate,
      source: row.routing_source,
      providerId: row.provider_id,
      model: row.model,
      upstreamProvider: row.upstream_provider,
      calls,
      freshInputTokens: Math.max(0, prompt - cached),
      cachedInputTokens: cached,
      outputTokens: number(row.completion_tokens),
      /** Null where the endpoint reported no cached-token count at all. */
      cacheRatio: cached > 0 && prompt > 0 ? cached / prompt : null,
      cacheReported: cached > 0,
      providerCostUsd: providerCost,
      /** Only meaningful when every call in the group reported a cost. */
      costPerUpdateUsd: providerCost !== null && reportedCalls === calls && calls ? providerCost / calls : null,
      projectedPer100Usd: providerCost !== null && reportedCalls === calls && calls ? (providerCost / calls) * 100 : null,
      costBasis: reportedCalls === calls && calls ? "provider_reported" : reportedCalls === 0 ? "estimated_only" : "mixed",
      estimatedCostUsd: row.estimated_cost === null ? null : Number(row.estimated_cost),
      meanLatencyMs: row.latency_ms === null ? null : Math.round(Number(row.latency_ms)),
    };
  });

  const skipped = payload.ledger.filter((row) => row.extraction_model === "skipped").reduce((sum, row) => sum + number(row.rows), 0);
  const failed = payload.ledger.filter((row) => row.status === "failed").reduce((sum, row) => sum + number(row.rows), 0);
  const extracted = payload.ledger
    .filter((row) => row.extraction_model !== "skipped" && row.status !== "failed")
    .reduce((sum, row) => sum + number(row.rows), 0);
  const eligible = skipped + extracted + failed;

  const sceneGroups = groups.filter((group) => group.task === "scene_state");
  const sceneCost = sceneGroups.reduce((sum, group) => sum + (group.providerCostUsd ?? 0), 0);
  const sceneCostReported = sceneGroups.length > 0 && sceneGroups.every((group) => group.costBasis === "provider_reported");

  const effective: Record<string, unknown> = {};
  for (const task of backgroundTasks) {
    const route = await backgroundRoute(task);
    effective[task] = {
      candidateId: route.candidateId,
      source: route.source,
      providerId: route.selection?.providerId ?? null,
      modelId: route.selection?.modelId ?? null,
    };
  }

  return Response.json({
    range: { id: range.id, label: range.label, from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
    /** What is running right now, so a report can be read against a decision. */
    effectiveRoutes: effective,
    /**
     * One row per (task, route, decision). Deliberately not summed: the four
     * mechanisms in the header comment are only separable while these stay
     * apart.
     */
    groups,
    sceneLedger: {
      /** Accepted story advances that reached the ledger. Regenerations never do. */
      eligibleTurns: eligible,
      extractorCalls: extracted,
      skipped,
      failed,
      skipRate: eligible ? skipped / eligible : null,
      costPerUpdateUsd: sceneCostReported && extracted ? sceneCost / extracted : null,
      /**
       * The figure the feature is actually judged on: what a hundred accepted
       * story advances cost, INCLUDING the ones that skipped and cost nothing.
       * Per-call cost falls when a model gets cheaper; this falls when either
       * the model or the call count does, which is the honest denominator.
       */
      costPer100AdvancesUsd: sceneCostReported && eligible ? (sceneCost / eligible) * 100 : null,
      costBasis: sceneCostReported ? "provider_reported" : "incomplete",
    },
    notes: [
      "Cached-token counts are provider-reported. A null cache ratio means the endpoint reported none, not that none occurred.",
      "Cost is provider-reported where every call in a group reported one; a group marked estimated_only or mixed must not be compared against one marked provider_reported.",
      "Scene Ledger skip counts come from the ledger table, not from usage events: a call that never happened leaves no usage row.",
    ],
  });
}
