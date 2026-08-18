import { requireAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { pricingAsOf } from "@/lib/usage";

const aggregate = `COUNT(*)::int requests,
  COALESCE(SUM(prompt_tokens),0)::int prompt_tokens,
  COALESCE(SUM(completion_tokens),0)::int completion_tokens,
  COALESCE(SUM(cache_hit_tokens),0)::int cache_hit_tokens,
  COALESCE(SUM(cache_miss_tokens),0)::int cache_miss_tokens,
  COALESCE(SUM(estimated_cost_usd),0) estimated_cost_usd`;

function usage(row: Record<string, unknown>) {
  return {
    promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens),
    cacheHitTokens: Number(row.cache_hit_tokens), cacheMissTokens: Number(row.cache_miss_tokens),
    requests: Number(row.requests), estimatedCostUsd: Number(row.estimated_cost_usd),
  };
}

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const [result, models, types] = await Promise.all([
    query(`SELECT ${aggregate} FROM usage_events`),
    query(`SELECT model, ${aggregate} FROM usage_events GROUP BY model ORDER BY requests DESC`),
    query(`SELECT usage_type, ${aggregate} FROM usage_events GROUP BY usage_type ORDER BY requests DESC`),
  ]);
  return Response.json({
    usage: usage(result.rows[0]),
    byModel: models.rows.map((item) => ({ key: String(item.model), ...usage(item) })),
    byType: types.rows.map((item) => ({ key: String(item.usage_type), ...usage(item) })),
    pricingAsOf,
  });
}
