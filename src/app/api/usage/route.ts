import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
import { pricingAsOf } from "@/lib/usage";
import { resolveUsageRange, usageRangeFilter } from "@/lib/usage-range";

const aggregate = `COUNT(*)::int requests,
  COALESCE(SUM(prompt_tokens),0)::int prompt_tokens,
  COALESCE(SUM(completion_tokens),0)::int completion_tokens,
  COALESCE(SUM(cache_hit_tokens),0)::int cache_hit_tokens,
  COALESCE(SUM(cache_miss_tokens),0)::int cache_miss_tokens,
  COALESCE(SUM(cache_write_tokens),0)::int cache_write_tokens,
  COALESCE(SUM(estimated_cost_usd),0) estimated_cost_usd,
  COALESCE(SUM(CASE WHEN funding_source='afterglow' THEN estimated_cost_usd ELSE 0 END),0) afterglow_cost_usd,
  COALESCE(SUM(CASE WHEN funding_source='byok' THEN estimated_cost_usd ELSE 0 END),0) byok_cost_usd,
  COALESCE(SUM(latency_ms),0)::int latency_ms_total,
  COUNT(latency_ms)::int latency_samples,
  COALESCE(SUM(ttft_ms),0)::int ttft_ms_total,
  COUNT(ttft_ms)::int ttft_samples`;

/**
 * One aggregate row.
 *
 * `cachedRatio` is the number the caching work is judged on: what share of the
 * prompt a provider served from its cache rather than re-reading. It is
 * derived here rather than stored so that a change to how it is defined does
 * not need a migration, and it is null rather than zero when there were no
 * prompt tokens at all — an empty bucket has no ratio, and showing 0% would
 * read as a regression that never happened.
 */
function usage(row: Record<string, unknown>) {
  const promptTokens = Number(row.prompt_tokens);
  const cacheHitTokens = Number(row.cache_hit_tokens);
  return {
    promptTokens, completionTokens: Number(row.completion_tokens),
    cacheHitTokens, cacheMissTokens: Number(row.cache_miss_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    cachedRatio: promptTokens > 0 ? cacheHitTokens / promptTokens : null,
    requests: Number(row.requests), estimatedCostUsd: Number(row.estimated_cost_usd),
    afterglowCostUsd: Number(row.afterglow_cost_usd ?? row.estimated_cost_usd),
    byokCostUsd: Number(row.byok_cost_usd ?? 0),
    // Averaged here rather than in SQL: only rows that actually reported a
    // measurement are counted, so a provider that omits TTFT cannot drag the
    // figure toward zero and make latency look better than it was.
    avgLatencyMs: Number(row.latency_samples) ? Math.round(Number(row.latency_ms_total) / Number(row.latency_samples)) : null,
    avgTtftMs: Number(row.ttft_samples) ? Math.round(Number(row.ttft_ms_total) / Number(row.ttft_samples)) : null,
  };
}

/**
 * The calling account's ledger only. Every aggregate is filtered by owner, so
 * one account's spend is never visible to, or mixed into, another's.
 */
export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied=adminRequired(account); if(denied)return denied;

  /*
   * One window, applied to everything.
   *
   * The report used to be all-time plus a separate "today", which answers
   * neither "what did last week cost" nor "what did that prompt change do".
   * Every aggregate below now shares one range, so the totals, the breakdowns
   * and the per-message figure describe the same period — a report whose parts
   * cover different windows is worse than one that covers the wrong window.
   *
   * The filtering is in SQL. Sending the ledger to the browser to be filtered
   * there would be both slower and a privacy regression, and it is exactly what
   * an account with a year of history cannot afford.
   */
  const range = resolveUsageRange(new URL(request.url).searchParams);
  const { predicate, values } = usageRangeFilter(account.id, range);

  const payload = await asUser(account.id, async (client) => {
    const scoped = (select: string, groupBy?: string) => client.query(
      `SELECT ${select} FROM usage_events WHERE ${predicate}${groupBy ? ` GROUP BY ${groupBy} ORDER BY requests DESC` : ""}`,
      values,
    );
    const [result, models, providers, engines, funding, types, upstream, replies, userMessages] = await Promise.all([
      scoped(aggregate),
      scoped(`model, ${aggregate}`, "model"),
      scoped(`provider_id, ${aggregate}`, "provider_id"),
      scoped(`rp_engine_id, ${aggregate}`, "rp_engine_id"),
      scoped(`funding_source, ${aggregate}`, "funding_source"),
      scoped(`usage_type, ${aggregate}`, "usage_type"),
      // Which upstream host actually served each generation. This is the other
      // half of the caching picture: stickiness is only working if one
      // conversation's turns keep landing on the same provider.
      scoped(`upstream_provider, ${aggregate}`, "upstream_provider"),
      // Volume the quota work will meter against: replies produced in range.
      client.query(
        `SELECT COUNT(*)::int count FROM messages WHERE ${predicate.replace("user_id=$1", "user_id=$1 AND role='assistant'")}`,
        values,
      ),
      // A branch copies transcript rows. authored_event_id preserves the
      // original accepted user turn, so branching cannot inflate this metric.
      client.query(
        `SELECT COUNT(DISTINCT COALESCE(authored_event_id,id))::int count FROM messages
         WHERE ${predicate.replace("user_id=$1", "user_id=$1 AND role='user' AND generation_started_at IS NOT NULL")}`,
        values,
      ),
    ]);
    const platformCost = Number(result.rows[0].afterglow_cost_usd);
    const messageCount = Number(userMessages.rows[0].count);
    return {
      range: { id: range.id, label: range.label, from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
      usage: usage(result.rows[0]),
      replies: Number(replies.rows[0].count),
      userMessages: messageCount,
      costPer100UserMessages: messageCount ? platformCost * 100 / messageCount : 0,
      byModel: models.rows.map((item) => ({ key: String(item.model), ...usage(item) })),
      byProvider: providers.rows.map((item) => ({ key: String(item.provider_id), ...usage(item) })),
      byEngine: engines.rows.map((item) => ({ key: String(item.rp_engine_id), ...usage(item) })),
      byFunding: funding.rows.map((item) => ({ key: String(item.funding_source), ...usage(item) })),
      byType: types.rows.map((item) => ({ key: String(item.usage_type), ...usage(item) })),
      byUpstreamProvider: upstream.rows.slice(0, 12).map((item) => ({ key: String(item.upstream_provider || "—"), ...usage(item) })),
      pricingAsOf,
    };
  });

  return Response.json(payload);
}
