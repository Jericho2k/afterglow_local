import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
import { driftVerdict, summarizeAffinity, summarizeProviderEconomics, type AffinityEvent } from "@/lib/provider-affinity";
import { costPolicyFor, modelCapabilities, routingMode } from "@/lib/provider";
import { resolveUsageRange, usageRangeFilter } from "@/lib/usage-range";

/**
 * The routing diagnostic: is one conversation actually bouncing between hosts?
 *
 * Usage & Cost already answers "what did each upstream provider cost this
 * account". This answers the question that one cannot: whether a SINGLE story
 * kept changing provider and paying fresh-input prices to re-read a prompt it
 * had already sent, or whether several stories each settled on a different host
 * and were warm the whole time. Those look identical in an account-wide
 * breakdown and need opposite responses.
 *
 * Admin-only, and reads nothing but the ledger — no message text, no title, no
 * character. A conversation is identified by its id, which is what makes a row
 * actionable without making it readable.
 */

/** The widest window that may be scanned at once. */
const maxEvents = 20_000;

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;

  const params = new URL(request.url).searchParams;
  // The same range vocabulary as Usage & Cost, so the two reports can be read
  // side by side and describe the same period.
  const range = resolveUsageRange(params);
  const { predicate, values } = usageRangeFilter(account.id, range);

  /*
   * Writer generations only.
   *
   * Consolidation, curation and Scene State run against completely different
   * prompts, so their cache behaviour says nothing about a roleplay's, and
   * folding them in would drag every ratio toward a number that describes no
   * workload at all.
   */
  const filters = [predicate, "usage_type IN ('chat','regenerate','continue')"];
  const scoped = [...values];
  const model = params.get("model")?.trim();
  if (model && /^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
    scoped.push(model);
    filters.push(`model = $${scoped.length}`);
  }

  const payload = await asUser(account.id, async (client) => {
    const { rows } = await client.query(
      `SELECT conversation_id, model, upstream_provider, created_at,
              prompt_tokens, cache_hit_tokens, completion_tokens, reasoning_tokens,
              provider_cost_usd, latency_ms, ttft_ms
         FROM usage_events
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at ASC
        LIMIT ${maxEvents}`,
      scoped,
    );

    const events: AffinityEvent[] = rows.map((row: Record<string, unknown>) => ({
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      model: String(row.model ?? ""),
      upstreamProvider: row.upstream_provider ? String(row.upstream_provider) : null,
      createdAt: new Date(String(row.created_at)).toISOString(),
      promptTokens: Number(row.prompt_tokens) || 0,
      cacheHitTokens: Number(row.cache_hit_tokens) || 0,
      completionTokens: Number(row.completion_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      providerCostUsd: row.provider_cost_usd === null || row.provider_cost_usd === undefined ? null : Number(row.provider_cost_usd),
      latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      ttftMs: row.ttft_ms === null || row.ttft_ms === undefined ? null : Number(row.ttft_ms),
    }));

    const conversations = summarizeAffinity(events);
    return {
      range: { id: range.id, label: range.label, from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
      model: model ?? null,
      /*
       * What the deployment is currently doing, beside what it produced.
       *
       * A cache figure without the policy that produced it is uninterpretable
       * three weeks later, when nobody remembers whether the ceiling was on.
       */
      routing: {
        mode: routingMode(),
        ...(model ? {
          costCeiling: modelCapabilities("openrouter", model).costCeiling ?? null,
          enforcedAllowlist: costPolicyFor(model)?.only ?? null,
        } : {}),
      },
      // Capped rather than paginated: this is a diagnostic, and a window that
      // needed more than this many events is one to narrow instead.
      truncated: rows.length >= maxEvents,
      generations: events.length,
      drift: driftVerdict(conversations),
      byProvider: summarizeProviderEconomics(events),
      // The long tail is noise for this question; the busiest stories are where
      // the money and the churn both are.
      byConversation: conversations.slice(0, 50),
    };
  });

  return Response.json(payload);
}
