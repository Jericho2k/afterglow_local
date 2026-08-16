import { requireAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const [result, models] = await Promise.all([query(`
    SELECT
      COALESCE(SUM(prompt_tokens),0)::int prompt_tokens,
      COALESCE(SUM(completion_tokens),0)::int completion_tokens,
      COALESCE(SUM(cache_hit_tokens),0)::int cache_hit_tokens,
      COALESCE(SUM(cache_miss_tokens),0)::int cache_miss_tokens,
      COUNT(*)::int requests
    FROM usage_events
  `), query(`
    SELECT model, COUNT(*)::int requests,
      COALESCE(SUM(prompt_tokens),0)::int prompt_tokens,
      COALESCE(SUM(completion_tokens),0)::int completion_tokens
    FROM usage_events GROUP BY model ORDER BY requests DESC
  `)]);
  const row = result.rows[0];
  return Response.json({
    usage: {
      promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens),
      cacheHitTokens: Number(row.cache_hit_tokens), cacheMissTokens: Number(row.cache_miss_tokens), requests: Number(row.requests),
    },
    byModel: models.rows.map((item) => ({ model: item.model, requests: Number(item.requests), promptTokens: Number(item.prompt_tokens), completionTokens: Number(item.completion_tokens) })),
  });
}
