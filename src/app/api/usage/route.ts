import { asUser } from "@/lib/db";
import { currentAccount, unauthorized } from "@/lib/session";
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

/**
 * The calling account's ledger only. Every aggregate is filtered by owner, so
 * one account's spend is never visible to, or mixed into, another's.
 */
export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();

  const payload = await asUser(account.id, async (client) => {
    const [result, models, types, today, replies] = await Promise.all([
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1`, [account.id]),
      client.query(`SELECT model, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY model ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT usage_type, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY usage_type ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1 AND created_at >= date_trunc('day', now())`, [account.id]),
      // Volume the quota work will meter against: replies produced today.
      client.query(
        `SELECT COUNT(*)::int count FROM messages
         WHERE user_id=$1 AND role='assistant' AND created_at >= date_trunc('day', now())`,
        [account.id],
      ),
    ]);
    return {
      usage: usage(result.rows[0]),
      today: usage(today.rows[0]),
      repliesToday: Number(replies.rows[0].count),
      byModel: models.rows.map((item) => ({ key: String(item.model), ...usage(item) })),
      byType: types.rows.map((item) => ({ key: String(item.usage_type), ...usage(item) })),
      pricingAsOf,
    };
  });

  return Response.json(payload);
}
