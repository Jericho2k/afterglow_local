import { asUser } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";
import { resolveUsageRange, usageRangeFilter } from "@/lib/usage-range";
import type { WriterCacheProbeResponse, WriterCacheProbeSample } from "@/lib/types";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account);
  if (denied) return denied;

  const range = resolveUsageRange(new URL(request.url).searchParams);
  const { predicate, values } = usageRangeFilter(account.id, range);

  const result = await asUser(account.id, (client) => client.query(
    `SELECT created_at,usage_type,model,upstream_provider,prompt_tokens,cache_hit_tokens,provider_metadata
       FROM usage_events
      WHERE ${predicate}
        AND task_route='rp_generation'
        AND provider_metadata ? 'cacheProbe'
      ORDER BY created_at DESC
      LIMIT 80`,
    values,
  ));

  const samples: WriterCacheProbeSample[] = result.rows.map((row) => {
    const metadata = object(row.provider_metadata);
    const probe = object(metadata.cacheProbe);
    const promptTokens = Math.max(0, Number(row.prompt_tokens) || 0);
    const cachedTokens = Math.max(0, Number(row.cache_hit_tokens) || 0);
    const structuralPrefixTokens = Math.max(0, Number(probe.structuralPrefixTokens) || 0);
    return {
      createdAt: new Date(String(row.created_at)).toISOString(),
      action: String(row.usage_type || ""),
      model: String(row.model || ""),
      upstreamProvider: row.upstream_provider ? String(row.upstream_provider) : null,
      upstreamOverride: probe.upstreamOverride ? String(probe.upstreamOverride) : null,
      promptTokens,
      cachedTokens,
      actualRatio: promptTokens ? cachedTokens / promptTokens : null,
      structuralPrefixTokens,
      structuralRatio: promptTokens ? Math.min(1, structuralPrefixTokens / promptTokens) : null,
      gapTokens: Math.max(0, structuralPrefixTokens - cachedTokens),
      anchorMoved: typeof probe.anchorMoved === "boolean" ? probe.anchorMoved : null,
      sharedMessages: Math.max(0, Number(probe.sharedMessages) || 0),
      totalMessages: Math.max(0, Number(probe.totalMessages) || 0),
      placement: probe.placement ? String(probe.placement) : null,
    };
  });

  const promptTokens = samples.reduce((sum, sample) => sum + sample.promptTokens, 0);
  const cachedTokens = samples.reduce((sum, sample) => sum + sample.cachedTokens, 0);
  const structuralPrefixTokens = samples.reduce((sum, sample) => sum + sample.structuralPrefixTokens, 0);
  const payload: WriterCacheProbeResponse = {
    samples,
    summary: {
      samples: samples.length,
      promptTokens,
      cachedTokens,
      structuralPrefixTokens,
      actualRatio: promptTokens ? cachedTokens / promptTokens : null,
      structuralRatio: promptTokens ? Math.min(1, structuralPrefixTokens / promptTokens) : null,
      gapTokens: Math.max(0, structuralPrefixTokens - cachedTokens),
    },
  };
  return Response.json(payload);
}
