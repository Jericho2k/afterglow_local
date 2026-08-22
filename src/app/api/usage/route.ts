import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
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
  const denied=adminRequired(account); if(denied)return denied;

  const payload = await asUser(account.id, async (client) => {
    const [result, models, providers, engines, funding, types, today, replies, userMessages] = await Promise.all([
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1`, [account.id]),
      client.query(`SELECT model, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY model ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT provider_id, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY provider_id ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT rp_engine_id, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY rp_engine_id ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT funding_source, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY funding_source ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT usage_type, ${aggregate} FROM usage_events WHERE user_id=$1 GROUP BY usage_type ORDER BY requests DESC`, [account.id]),
      client.query(`SELECT ${aggregate} FROM usage_events WHERE user_id=$1 AND created_at >= date_trunc('day', now())`, [account.id]),
      // Volume the quota work will meter against: replies produced today.
      client.query(
        `SELECT COUNT(*)::int count FROM messages
         WHERE user_id=$1 AND role='assistant' AND created_at >= date_trunc('day', now())`,
        [account.id],
      ),
      // A branch copies transcript rows. authored_event_id preserves the
      // original accepted user turn, so branching cannot inflate this metric.
      client.query("SELECT COUNT(DISTINCT COALESCE(authored_event_id,id))::int count FROM messages WHERE user_id=$1 AND role='user'", [account.id]),
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
      pricingAsOf,
    };
  });

  return Response.json(payload);
}
