import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
import { pricingAsOf } from "@/lib/usage";

const aggregate = `COUNT(*)::int requests,
  COALESCE(SUM(prompt_tokens),0)::int prompt_tokens,
  COALESCE(SUM(completion_tokens),0)::int completion_tokens,
  COALESCE(SUM(cache_hit_tokens),0)::int cache_hit_tokens,
  COALESCE(SUM(cache_miss_tokens),0)::int cache_miss_tokens,
  COALESCE(SUM(cache_write_tokens),0)::int cache_write_tokens,
  COALESCE(SUM(estimated_cost_usd),0) estimated_cost_usd,
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
export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied=adminRequired(account); if(denied)return denied;

  const payload = await asUser(account.id, async (client) => {
    const [result, models, providers, engines, funding, types, upstream, today, replies, userMessages] = await Promise.all([
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1`, [account.id]),
      client.query(`SELECT model, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY model ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT provider_id, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY provider_id ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT rp_engine_id, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY rp_engine_id ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT funding_source, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY funding_source ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT usage_type, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY usage_type ORDER BY requests DESC`, [account.id]),
      // Which upstream host actually served each generation. This is the other
      // half of the caching picture: stickiness is only working if one
      // conversation's turns keep landing on the same provider.
      client.query(
        `SELECT upstream_provider, ${aggregate}
         FROM usage_events WHERE user_id=$1 GROUP BY upstream_provider ORDER BY requests DESC LIMIT 12`,
        [account.id],
      ),
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1 AND created_at >= date_trunc('day', now())`, [account.id]),
      // Volume the quota work will meter against: replies produced today.
      client.query(
        `SELECT COUNT(*)::int count FROM messages
         WHERE user_id=$1 AND role='assistant' AND created_at >= date_trunc('day', now())`,
        [account.id],
      ),
      // A branch copies transcript rows. authored_event_id preserves the
      // original accepted user turn, so branching cannot inflate this metric.
      client.query("SELECT COUNT(DISTINCT COALESCE(authored_event_id,id))::int count FROM messages WHERE user_id=$1 AND role='user' AND generation_started_at IS NOT NULL", [account.id]),
    ]);
    return {
      usage: usage(result.rows[0]),
      today: usage(today.rows[0]),
      repliesToday: Number(replies.rows[0].count),
      userMessages: Number(userMessages.rows[0].count),
      costPer100UserMessages: Number(userMessages.rows[0].count) ? Number(result.rows[0].estimated_cost_usd) * 100 / Number(userMessages.rows[0].count) : 0,
      byModel: models.rows.map((item) => ({ key: String(item.model), ...usage(item) })),
      byProvider: providers.rows.map((item) => ({ key: String(item.provider_id), ...usage(item) })),
      byEngine: engines.rows.map((item) => ({ key: String(item.rp_engine_id), ...usage(item) })),
      byFunding: funding.rows.map((item) => ({ key: String(item.funding_source), ...usage(item) })),
      byType: types.rows.map((item) => ({ key: String(item.usage_type), ...usage(item) })),
      byUpstreamProvider: upstream.rows.map((item) => ({ key: String(item.upstream_provider || "—"), ...usage(item) })),
      pricingAsOf,
    };
  });

  return Response.json(payload);
}
