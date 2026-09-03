import { asUser, getUserSettings } from "@/lib/db";
import { costCeilingFor, providerModelId, resolveModel, safeProviderTag } from "@/lib/provider";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";

const supportedModels = new Set(["glm-5.3-flash"]);

type EndpointRow = {
  tag: string;
  name: string;
  providerName: string;
  promptUsdPerMillion: number | null;
  cachedUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  quantization: string | null;
  status: string | null;
  cacheCapable: boolean;
  withinCostGuard: boolean;
};

function openRouterBase() {
  return (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
}

function numberPerMillion(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : null;
}

async function endpointsFor(modelId: string): Promise<EndpointRow[]> {
  const upstreamModel = providerModelId("openrouter", modelId);
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!upstreamModel || !key) return [];

  const response = await fetch(`${openRouterBase()}/models/${upstreamModel}/endpoints`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`OpenRouter endpoint catalogue returned ${response.status}`);

  const body = await response.json().catch(() => null) as {
    data?: { endpoints?: Array<Record<string, unknown>> };
  } | null;
  const endpoints = Array.isArray(body?.data?.endpoints) ? body!.data!.endpoints! : [];
  const ceiling = costCeilingFor(modelId);

  return endpoints.map((endpoint) => {
    const pricing = endpoint.pricing && typeof endpoint.pricing === "object"
      ? endpoint.pricing as Record<string, unknown>
      : {};
    const tag = String(endpoint.tag || endpoint.provider_name || "");
    const prompt = numberPerMillion(pricing.prompt);
    const cached = numberPerMillion(pricing.input_cache_read);
    const output = numberPerMillion(pricing.completion);
    const withinCostGuard = !ceiling || (
      prompt != null && output != null
      && prompt <= ceiling.prompt
      && output <= ceiling.completion
    );
    return {
      tag,
      name: String(endpoint.name || endpoint.provider_name || tag),
      providerName: String(endpoint.provider_name || ""),
      promptUsdPerMillion: prompt,
      cachedUsdPerMillion: cached,
      outputUsdPerMillion: output,
      quantization: endpoint.quantization ? String(endpoint.quantization) : null,
      status: endpoint.status ? String(endpoint.status) : null,
      cacheCapable: cached != null,
      withinCostGuard,
    };
  }).filter((endpoint) => safeProviderTag(endpoint.tag));
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account);
  if (denied) return denied;

  const modelId = new URL(request.url).searchParams.get("model") || "glm-5.3-flash";
  if (!supportedModels.has(modelId) || !resolveModel("openrouter", modelId)) {
    return Response.json({ error: "That writer is not available for provider experiments." }, { status: 400 });
  }

  const [settings, endpoints] = await Promise.all([
    asUser(account.id, (client) => getUserSettings(client, account.id)),
    endpointsFor(modelId),
  ]);
  const selected = settings.adminWriterUpstreamOverrides?.[modelId] || null;
  return Response.json({
    modelId,
    selected,
    shippedDefault: "z-ai",
    endpoints,
    note: "Only this admin account is affected. Each choice is a hard provider.only pin with fallbacks off; the model's price and privacy guards remain enforced.",
  });
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as { modelId?: unknown; upstreamProvider?: unknown } | null;
  const modelId = String(body?.modelId || "");
  const upstreamProvider = body?.upstreamProvider == null ? null : String(body.upstreamProvider).trim();

  if (!supportedModels.has(modelId) || !resolveModel("openrouter", modelId)) {
    return Response.json({ error: "That writer is not available for provider experiments." }, { status: 400 });
  }

  if (upstreamProvider) {
    if (!safeProviderTag(upstreamProvider)) {
      return Response.json({ error: "Invalid OpenRouter provider tag." }, { status: 400 });
    }
    const live = await endpointsFor(modelId);
    const endpoint = live.find((item) => item.tag === upstreamProvider);
    if (!endpoint) return Response.json({ error: "That provider tag is not currently serving this model." }, { status: 409 });
    if (!endpoint.cacheCapable) return Response.json({ error: "That endpoint does not advertise discounted prompt-cache reads." }, { status: 409 });
    if (!endpoint.withinCostGuard) return Response.json({ error: "That endpoint is outside Afterglow's current writer price guard." }, { status: 409 });
  }

  const selected = await asUser(account.id, async (client) => {
    const current = await getUserSettings(client, account.id);
    const next = { ...(current.adminWriterUpstreamOverrides || {}) };
    if (upstreamProvider) next[modelId] = upstreamProvider;
    else delete next[modelId];
    await client.query(
      "UPDATE user_settings SET admin_writer_upstream_overrides=$1::jsonb,updated_at=now() WHERE user_id=$2",
      [JSON.stringify(next), account.id],
    );
    return next[modelId] || null;
  });

  return Response.json({ modelId, selected });
}
