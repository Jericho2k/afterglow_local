import { query } from "./db";
import { resolveModel, taskModelSelection, type InferenceSelection, type InferenceTask } from "./provider";

/**
 * WHICH MODEL DOES THE BACKGROUND WORK, AND WHO GETS TO DECIDE.
 *
 * Until now the answer was an environment variable, which means the answer was
 * "whoever can redeploy". That is the wrong shape for the question actually
 * being asked, which is not "what should the memory model be forever" but "run
 * this one for a fortnight and show me what it did to quality and to the bill".
 * An A/B whose smallest unit of change is a deploy is an A/B nobody runs.
 *
 * So the normal runtime control is a row in `background_model_routes`, written
 * by an administrator, and the environment routes stay exactly where they were
 * as the fallback beneath it. Four layers, most specific first:
 *
 *   1. A per-conversation admin override, for a controlled side-by-side inside
 *      one story.
 *   2. The global admin setting. THE NORMAL CONTROL.
 *   3. `MEMORY_CONSOLIDATION_MODEL_ROUTE` and friends — the emergency lever
 *      that works when the database does not.
 *   4. The code's own default, so a fresh deployment and a failed config read
 *      land on the same known-good route rather than on nothing.
 *
 * THE SETTING IS NOT RETROACTIVE, AND THIS IS THE INVARIANT THAT MATTERS MOST.
 * Changing it changes which model does the NEXT piece of background work.
 * Nothing already written is regenerated, re-extracted, re-summarised or
 * re-scored, because a memory is a fact about a reader's story rather than an
 * output of the model that happened to phrase it, and rewriting the archive
 * every time somebody tries a cheaper extractor would make the archive a
 * function of the operator's experiments. There is deliberately no migration
 * path in this file, and adding one would be a product decision rather than a
 * routing one.
 *
 * CANON CURATION IS ROUTED SEPARATELY. It shares the candidate list because the
 * same models are capable of it, and it has its own row: curation reads the
 * whole conversation's canon and rewrites a small set of foundational entries,
 * which is a different job from extracting atomic memories out of a window, and
 * a deployment that wants to move one and not the other must be able to.
 */

/** The background jobs whose model an administrator may choose. */
export type BackgroundTask = Extract<InferenceTask, "memory_consolidation" | "memory_curation" | "scene_state">;

export const backgroundTasks: BackgroundTask[] = ["memory_consolidation", "memory_curation", "scene_state"];

export function isBackgroundTask(value: string): value is BackgroundTask {
  return (backgroundTasks as string[]).includes(value);
}

/**
 * One selectable answer.
 *
 * `selection` is null for the single option that is not a model — Scene Ledger
 * turned off — because "run nothing" has to be as expressible as "run Ling",
 * and expressing it as a magic model id would put a null check in every caller
 * anyway with worse names on it.
 */
export type BackgroundCandidate = {
  /** Stored in the database and in usage provenance. Never renamed. */
  id: string;
  label: string;
  /** One sentence an administrator can choose on. */
  description: string;
  /** Which jobs this candidate may be selected for. */
  tasks: BackgroundTask[];
  selection: InferenceSelection | null;
  /**
   * The upstream host this candidate pins, when it pins one.
   *
   * Present only for the routes whose whole purpose is to name a host. A
   * candidate without one is served by whichever endpoint the model's ordinary
   * routing policy chooses.
   */
  upstreamProvider?: string;
  /**
   * Whether an operator has to name this candidate's host before it can be
   * selected.
   *
   * NOT the same question as "is the tag correct", and the difference matters
   * now that both tags have been verified. `open-inference/fp8` and
   * `relace/fp4` are the real routing tags, confirmed against OpenRouter's
   * endpoint list — and a pinned host is still `provider.only` with fallbacks
   * off, aimed at a third party's catalogue that can rename or retire a tag
   * without telling us, carrying readers' transcripts.
   *
   * So the gate stays, and what it asks for is CONSENT rather than spelling: an
   * operator naming a host in `BACKGROUND_ROUTE_VERIFIED_UPSTREAMS` is saying "I
   * have checked this route today and I am willing to send readers' stories
   * through it". `scripts/background-route-verify.mjs` is how they check it.
   */
  requiresUpstreamOptIn: boolean;
};

/**
 * THE FIELD.
 *
 * DeepSeek's own endpoint is the control and stays the default. Its extracted
 * memories are what production has been running on and what the product's
 * continuity quality is currently judged against, so a challenger replaces it
 * on evidence from `tests/eval/memory-models.test.ts` and not on price.
 */
export const backgroundCandidates: BackgroundCandidate[] = [
  {
    id: "direct_deepseek",
    label: "Direct DeepSeek V4 Flash",
    description: "DeepSeek's own endpoint. The incumbent and the quality control for every comparison.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    requiresUpstreamOptIn: false,
  },
  {
    id: "deepseek_0731",
    label: "DeepSeek V4 Flash 0731 — any host",
    description: "The re-post-trained 0731 revision via OpenRouter, host chosen by the usual routing policy. The control for the two pinned routes below.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "openrouter", modelId: "deepseek-v4-flash-0731" },
    requiresUpstreamOptIn: false,
  },
  {
    id: "deepseek_0731_openinference",
    label: "DeepSeek V4 Flash 0731 — OpenInference (fp8)",
    description: "The 0731 revision, pinned to OpenInference at fp8. $0.05/M fresh, $0.013/M cached, $0.16/M output.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "openrouter", modelId: "deepseek-v4-flash-0731-openinference" },
    upstreamProvider: "open-inference/fp8",
    requiresUpstreamOptIn: true,
  },
  {
    id: "deepseek_0731_relace",
    label: "DeepSeek V4 Flash 0731 — Relace (fp4)",
    description: "The 0731 revision, pinned to Relace at fp4. $0.065/M fresh, $0.016/M cached, $0.18/M output.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "openrouter", modelId: "deepseek-v4-flash-0731-relace" },
    upstreamProvider: "relace/fp4",
    requiresUpstreamOptIn: true,
  },
  {
    id: "mimo_v25",
    label: "MiMo V2.5",
    description: "Xiaomi's long-context writer. Already funded and already trusted for structured output.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "openrouter", modelId: "mimo-v2.5" },
    requiresUpstreamOptIn: false,
  },
  {
    id: "ling_3_flash",
    label: "Ling 3.0 Flash",
    description: "The cheapest route in the lineup. Experimental for memory; the intended default for the Scene Ledger.",
    tasks: ["memory_consolidation", "memory_curation", "scene_state"],
    selection: { providerId: "openrouter", modelId: "ling-3.0-flash" },
    requiresUpstreamOptIn: false,
  },
  {
    /*
     * Not a model, and deliberately offered anyway.
     *
     * The Scene Ledger is a feature whose value is a product question — does
     * knowing where and when the story is measurably improve replies — and the
     * only way to answer it is to be able to turn it off and compare. A feature
     * that cannot be switched off cannot be shown to be worth its cost.
     */
    id: "off",
    label: "Disabled",
    description: "Run no extractor at all. The ledger stops updating and the writer sees whatever it last held.",
    tasks: ["scene_state"],
    selection: null,
    requiresUpstreamOptIn: false,
  },
];

export function backgroundCandidate(id: string) {
  return backgroundCandidates.find((candidate) => candidate.id === id) ?? null;
}

export function candidatesForTask(task: BackgroundTask) {
  return backgroundCandidates.filter((candidate) => candidate.tasks.includes(task));
}

/**
 * The upstream hosts an operator has opted this deployment into.
 *
 * A list rather than a boolean because the pinned routes are opted into
 * separately: OpenRouter can perfectly well serve one of them and not the
 * other, they are priced differently and quantised differently, and "we are
 * willing to use this" is a claim about one host.
 *
 * Entries are the full routing tag, suffix included —
 * `open-inference/fp8,relace/fp4` — because the suffix is part of the route and
 * naming `open-inference` alone would opt into a host at a precision nobody
 * looked at.
 */
function verifiedUpstreams() {
  return new Set(
    (process.env.BACKGROUND_ROUTE_VERIFIED_UPSTREAMS || "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
}

export type CandidateAvailability = {
  candidate: BackgroundCandidate;
  selectable: boolean;
  /** Why not, in a sentence an administrator can act on. Empty when selectable. */
  reason: string;
};

/**
 * Whether one candidate may be chosen on this deployment right now.
 *
 * Three ways to be unselectable, and each is a different operator action:
 * the model is not enabled here (turn on the provider), the host slug is
 * unverified (run the verification script and set the variable), or the
 * candidate is not offered for this job at all (choose a different one).
 */
export function candidateAvailability(task: BackgroundTask, candidate: BackgroundCandidate): CandidateAvailability {
  if (!candidate.tasks.includes(task)) {
    return { candidate, selectable: false, reason: `Not offered for ${task.replace(/_/g, " ")}.` };
  }
  if (!candidate.selection) return { candidate, selectable: true, reason: "" };
  if (!resolveModel(candidate.selection.providerId, candidate.selection.modelId)) {
    return { candidate, selectable: false, reason: "That provider is not enabled on this deployment." };
  }
  if (candidate.requiresUpstreamOptIn && !verifiedUpstreams().has(candidate.upstreamProvider?.toLowerCase() ?? candidate.id)) {
    return {
      candidate,
      selectable: false,
      reason: `Pinned to the upstream host "${candidate.upstreamProvider}", which nobody has opted into on this deployment. Add it to BACKGROUND_ROUTE_VERIFIED_UPSTREAMS; scripts/background-route-verify.mjs re-checks the tag against OpenRouter's live endpoint list first.`,
    };
  }
  return { candidate, selectable: true, reason: "" };
}

export function availabilityForTask(task: BackgroundTask) {
  return candidatesForTask(task).map((candidate) => candidateAvailability(task, candidate));
}

/** Where a resolved route came from. Recorded on every background usage row. */
export type BackgroundRouteSource = "conversation_override" | "admin_global" | "environment" | "default";

export type BackgroundRoute = {
  task: BackgroundTask;
  /** The candidate this resolved to, or null when no candidate names it. */
  candidateId: string | null;
  /** Null means: do not run this job at all. */
  selection: InferenceSelection | null;
  source: BackgroundRouteSource;
};

/*
 * The stored global settings, cached for a few seconds.
 *
 * Background jobs are infrequent, so this is not a hot path and the cache is
 * not about throughput — it is about a burst of consolidations after a busy
 * minute not each paying a round trip for an answer that cannot have changed.
 * Short enough that an administrator flipping the setting sees it take effect
 * while they are still looking at the page.
 */
const configTtlMs = 10_000;
let cached: { at: number; rows: Map<BackgroundTask, string> } | null = null;

export function clearBackgroundRouteCache() {
  cached = null;
}

/** The admin-chosen candidate per task. Empty on any read failure. */
export async function backgroundRouteConfig(): Promise<Map<BackgroundTask, string>> {
  if (cached && Date.now() - cached.at < configTtlMs) return cached.rows;
  try {
    const result = await query<{ task: string; candidate_id: string }>("SELECT task,candidate_id FROM background_model_routes");
    const rows = new Map<BackgroundTask, string>();
    for (const row of result.rows) {
      if (isBackgroundTask(row.task) && backgroundCandidate(row.candidate_id)) rows.set(row.task, row.candidate_id);
    }
    cached = { at: Date.now(), rows };
    return rows;
  } catch (error) {
    /*
     * Background work must survive its own configuration table.
     *
     * An unreachable settings table falls through to the environment routes and
     * then to the code default, which is precisely the behaviour every
     * deployment had before this table existed. It is NOT cached: a failed read
     * is not an answer, and caching it would extend a transient outage into ten
     * seconds of ignoring the operator's setting.
     */
    console.warn("[background-routing] could not read the global setting", error instanceof Error ? error.message : error);
    return new Map();
  }
}

/**
 * Writes one global setting. Returns what is now in force.
 *
 * Callers are responsible for the admin check; this function is the storage,
 * not the gate. It refuses a candidate that is not selectable rather than
 * storing an intention that would fail at 3am on the first job that used it.
 */
export async function setBackgroundRoute(task: BackgroundTask, candidateId: string, adminUserId: string) {
  const candidate = backgroundCandidate(candidateId);
  if (!candidate) throw new Error("That is not a known background model");
  const availability = candidateAvailability(task, candidate);
  if (!availability.selectable) throw new Error(availability.reason);
  await query(
    `INSERT INTO background_model_routes (task,candidate_id,updated_by,updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (task) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [task, candidateId, adminUserId],
  );
  clearBackgroundRouteCache();
  return candidate;
}

/** Removes the global setting, returning the task to the environment fallback. */
export async function clearBackgroundRoute(task: BackgroundTask) {
  await query("DELETE FROM background_model_routes WHERE task=$1", [task]);
  clearBackgroundRouteCache();
}

/**
 * The environment/code fallback for one task, as a route.
 *
 * `taskModelSelection` throws when a configured route names something this
 * deployment cannot serve, which is right for a misconfiguration and wrong as
 * an outcome for a background job: it would turn one bad variable into every
 * memory job failing. So the throw is caught and the code default answers,
 * loudly.
 */
function fallbackRoute(task: BackgroundTask): BackgroundRoute {
  const configured = Boolean(process.env[`${task.toUpperCase()}_MODEL_ROUTE`]?.trim());
  try {
    const selection = taskModelSelection(task);
    const candidate = backgroundCandidates.find(
      (entry) => entry.selection?.providerId === selection.providerId && entry.selection?.modelId === selection.modelId,
    );
    return { task, candidateId: candidate?.id ?? null, selection, source: configured ? "environment" : "default" };
  } catch (error) {
    console.error(`[background-routing] ${task} environment route is unusable; falling back to DeepSeek`, error instanceof Error ? error.message : error);
    return { task, candidateId: "direct_deepseek", selection: { providerId: "deepseek", modelId: "deepseek-v4-flash" }, source: "default" };
  }
}

/**
 * THE ONE FUNCTION BACKGROUND JOBS CALL.
 *
 * `overrideCandidateId` is the per-conversation admin override, read by the
 * caller from the conversation row. It is applied here rather than in each job
 * so that "which layer won" is decided in one place and recorded the same way
 * everywhere.
 *
 * An override or a stored setting naming a candidate that has since become
 * unselectable — a provider disabled, a verification withdrawn — falls through
 * to the next layer rather than failing. A stale setting must not be able to
 * stop a reader's memories being written.
 */
export async function backgroundRoute(task: BackgroundTask, options: { overrideCandidateId?: string | null } = {}): Promise<BackgroundRoute> {
  const override = options.overrideCandidateId ? backgroundCandidate(options.overrideCandidateId) : null;
  if (override && candidateAvailability(task, override).selectable) {
    return { task, candidateId: override.id, selection: override.selection, source: "conversation_override" };
  }

  const configured = (await backgroundRouteConfig()).get(task);
  const chosen = configured ? backgroundCandidate(configured) : null;
  if (chosen && candidateAvailability(task, chosen).selectable) {
    return { task, candidateId: chosen.id, selection: chosen.selection, source: "admin_global" };
  }

  /*
   * The Scene Ledger's code default is Ling rather than DeepSeek.
   *
   * It is the one background job whose whole design assumes a very cheap
   * structured extractor: a tiny prompt, a tiny reply, a schema that is
   * validated and retried rather than trusted, and a previous ledger to fall
   * back to when it fails. Nothing about it is improved by a dearer model, and
   * the failure path — keep the last ledger — is the same failure path a
   * disabled ledger has. Memory extraction has neither property and keeps
   * DeepSeek.
   */
  if (task === "scene_state" && !process.env.SCENE_STATE_MODEL_ROUTE?.trim()) {
    const ling = backgroundCandidate("ling_3_flash")!;
    if (candidateAvailability(task, ling).selectable) {
      return { task, candidateId: ling.id, selection: ling.selection, source: "default" };
    }
  }

  return fallbackRoute(task);
}

/** The provenance stamped onto a background usage row. */
export function routeProvenance(route: BackgroundRoute) {
  return {
    task: route.task,
    candidate: route.candidateId,
    source: route.source,
  };
}
