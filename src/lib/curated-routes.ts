import { query } from "./db";
import { availableModels, isFreeModel } from "./provider";
import { routeHealth, type RouteHealth, type RouteHealthState } from "./route-health";
import { availableCatalog } from "./provider";
import type { ModelCategory, ModelDefinition } from "./types";

/**
 * THE CATALOGUE THE SERVER OWNS, AND WHY IT IS NOT A CMS.
 *
 * OpenRouter's free lineup changes weekly. Routes appear, vanish, and are
 * renamed, and every one of those events has the same consequence here: a
 * catalogue entry that 404s for every reader who chose it. Waiting for a deploy
 * to remove one is waiting for hours with a broken model in the picker.
 *
 * So availability is DATA. `curated_model_routes` can disable a route, move it
 * to another shelf, attach a notice, tighten its health thresholds and change
 * its per-user cap eligibility — all without a release.
 *
 * WHAT IT DELIBERATELY CANNOT DO, and this is the line that keeps it from
 * becoming a content system: it cannot invent a model, cannot change a slug,
 * cannot widen a context window and cannot lower a privacy floor. Every row
 * refers to a catalogue entry that already exists in src/lib/provider.ts, and a
 * row naming a model this build has never heard of is ignored rather than
 * conjured into existence. Adding a genuinely new writer stays a code change,
 * because the request body it needs, the context it fits into and the data
 * policy it is sent with are engineering decisions that deserve a review.
 *
 * KNOWN-SAFE DEFAULTS LIVE IN CODE. An empty table means "ship what the code
 * says", so a fresh deployment and a database outage both degrade to the
 * catalogue as written rather than to no catalogue at all.
 */

export type CuratedRouteConfig = {
  modelId: string;
  enabled: boolean;
  category: ModelCategory | null;
  notice: string | null;
  maxTtftMs: number | null;
  minThroughputTps: number | null;
  perUserDailyCap: number | null;
  dataPolicyNote: string | null;
};

/** The curated overrides, keyed by catalogue id. Empty on any read failure. */
export async function curatedRouteConfig(): Promise<Map<string, CuratedRouteConfig>> {
  try {
    const rows = await query<{
      model_id: string; enabled: boolean; category: string | null; notice: string | null;
      max_ttft_ms: number | null; min_throughput_tps: string | number | null;
      per_user_daily_cap: number | null; data_policy_note: string | null;
    }>(
      `SELECT model_id,enabled,category,notice,max_ttft_ms,min_throughput_tps,per_user_daily_cap,data_policy_note
         FROM curated_model_routes`,
    );
    const categories: ModelCategory[] = ["recommended", "economy", "free", "experimental"];
    return new Map(rows.rows.map((row) => [row.model_id, {
      modelId: row.model_id,
      enabled: row.enabled !== false,
      category: categories.includes(row.category as ModelCategory) ? row.category as ModelCategory : null,
      notice: row.notice?.trim() || null,
      maxTtftMs: row.max_ttft_ms === null ? null : Number(row.max_ttft_ms),
      minThroughputTps: row.min_throughput_tps === null ? null : Number(row.min_throughput_tps),
      perUserDailyCap: row.per_user_daily_cap === null ? null : Number(row.per_user_daily_cap),
      dataPolicyNote: row.data_policy_note?.trim() || null,
    }]));
  } catch (error) {
    // The catalogue must survive its own configuration table. An unreachable
    // override table means the code's defaults ship, which is the behaviour
    // every deployment had before this table existed.
    console.warn("[curated-routes] could not read overrides", error instanceof Error ? error.message : error);
    return new Map();
  }
}

/**
 * A catalogue entry as the picker should render it right now.
 *
 * `availability` is present only for routes whose availability is genuinely in
 * question — the free ones. A paid model's availability is a provider incident,
 * handled by failover and by the retirement message, and decorating every paid
 * row with a green dot would train readers to ignore the one place the dot
 * means something.
 */
export type CatalogEntry = ModelDefinition;

/** How a health state reads to somebody choosing a writer. */
const availabilityNotice: Record<RouteHealthState, string> = {
  available: "",
  busy: "Busy right now — free capacity is shared. Try again shortly.",
  unavailable: "Temporarily unavailable.",
};

function applyHealth(entry: CatalogEntry, health: RouteHealth | undefined, config: CuratedRouteConfig | undefined): CatalogEntry | null {
  if (!health) return entry;
  /*
   * THE ONE HARD GATE: a route that takes longer than the interactive floor to
   * say anything is not offered for chat, however cheap it is. Everything else
   * here is a label or an ordering; this is the only rule that removes a row,
   * and it removes it from the PICKER rather than from the database — the route
   * comes back the moment its measured latency does.
   */
  const ttftCeiling = config?.maxTtftMs ?? null;
  const overCustomCeiling = ttftCeiling !== null && health.meanTtftMs !== null && health.meanTtftMs > ttftCeiling;
  if (health.belowInteractiveFloor || overCustomCeiling) return null;

  const slow = health.slowStreaming
    || (config?.minThroughputTps != null && health.meanThroughputTps !== null && health.meanThroughputTps < config.minThroughputTps);
  const notice = [entry.notice, availabilityNotice[health.state]].filter(Boolean).join(" ");
  return {
    ...entry,
    availability: health.state,
    ...(slow ? { deprioritized: true } : {}),
    ...(notice ? { notice } : {}),
  };
}

/**
 * The catalogue, after the server's own curation.
 *
 * Order within a shelf matters: a deprioritised route — one that works but
 * streams slowly — sinks below its peers rather than disappearing, because
 * "slow" is a trade a reader is allowed to make and "hidden" is not a trade at
 * all.
 */
export async function curatedModels(): Promise<CatalogEntry[]> {
  const models = availableModels();
  const [config, health] = await Promise.all([
    curatedRouteConfig(),
    routeHealth(models.filter((model) => isFreeModel(model.id)).map((model) => model.id)),
  ]);

  const entries: CatalogEntry[] = [];
  for (const model of models) {
    const override = config.get(model.id);
    if (override && !override.enabled) continue;
    const base: CatalogEntry = {
      ...model,
      ...(override?.category ? { category: override.category } : {}),
      ...(override?.notice ? { notice: override.notice } : {}),
    };
    // Health only decides anything for the volatile routes. A paid model with
    // no health row is not "unmeasured", it is simply not in this question.
    const decided = isFreeModel(model.id) ? applyHealth(base, health.get(model.id), override) : base;
    if (decided) entries.push(decided);
  }
  return entries.sort((a, b) => Number(Boolean(a.deprioritized)) - Number(Boolean(b.deprioritized)));
}

/**
 * Whether one route may be generated on right now.
 *
 * Asked at generation time rather than only at picker time, because a reader's
 * conversation stores the model it was started with and the picker's answer can
 * be minutes old. A route that has been disabled since then must refuse here,
 * with a reason the chat route can turn into "choose another model" rather than
 * into a mystery failure.
 */
export async function routeGenerationAllowed(modelId: string): Promise<{ allowed: true } | { allowed: false; reason: "disabled" | "unavailable" }> {
  const config = await curatedRouteConfig();
  if (config.get(modelId)?.enabled === false) return { allowed: false, reason: "disabled" };
  if (!isFreeModel(modelId)) return { allowed: true };
  const health = (await routeHealth([modelId])).get(modelId);
  /*
   * A BUSY ROUTE IS STILL ALLOWED TO BE TRIED.
   *
   * Health is a rolling summary of the last hour, not a live capacity check,
   * and free endpoints recover in minutes. Refusing on "busy" would make the
   * product slower to recover than the provider is. Only a route that is
   * failing for reasons other than capacity, or whose latency has fallen below
   * the interactive floor, is refused before it is attempted.
   */
  if (health && (health.state === "unavailable" || health.belowInteractiveFloor)) {
    return { allowed: false, reason: "unavailable" };
  }
  return { allowed: true };
}

/**
 * The whole catalogue a client renders: providers, curated models, engines.
 *
 * Wraps `availableCatalog()` rather than replacing it, so the deployment's
 * enabled-model and engine logic stays in one place and this file only decides
 * which of those models are offered right now.
 */
export async function curatedCatalog() {
  const base = availableCatalog();
  const models = await curatedModels();
  return {
    // A provider with nothing left to offer should not appear as an empty
    // group in the picker.
    providers: base.providers.filter((provider) => models.some((model) => model.providerId === provider.id)),
    models,
    engines: base.engines,
  };
}

/** The per-user daily cap for one route, when the server has set a specific one. */
export async function routeUserDailyCap(modelId: string): Promise<number | null> {
  return (await curatedRouteConfig()).get(modelId)?.perUserDailyCap ?? null;
}
