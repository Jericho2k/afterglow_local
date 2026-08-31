import { query } from "./db";

/**
 * HOW A VOLATILE ROUTE IS REPORTED WITHOUT BEING RETIRED.
 *
 * Free endpoints are not like paid ones. They go busy for twenty minutes, come
 * back, change provider underneath the same slug, and go busy again. A reader
 * whose chosen writer disappears from the catalogue during one of those hours
 * has lost their model permanently for a reason that lasted less time than
 * their coffee.
 *
 * So NOTHING HERE DELETES ANYTHING. Health is a rolling window written beside a
 * route, and the strongest thing it can say is "temporarily unavailable". The
 * route stays in the database, stays in the catalogue, and comes back on its
 * own the moment a request succeeds. Permanent removal is a curation decision a
 * human makes in `curated_model_routes`, never a conclusion this file reaches
 * from a bad hour.
 *
 * THREE STATES, chosen so that each one has a different reader answer:
 *
 *   available    Recent requests are succeeding. Use it.
 *   busy         The route is refusing on CAPACITY — 429s, "no instances" —
 *                which is what free endpoints do at peak. Try again shortly,
 *                or use something else now.
 *   unavailable  The route is failing for reasons that are not capacity, or
 *                failing overwhelmingly. Something is wrong with it.
 *
 * "Busy" and "unavailable" are deliberately not merged. They send a reader to
 * different remedies, and conflating them is how a product ends up telling
 * somebody a model is broken when it is merely popular.
 *
 * THE WINDOW IS RESET, NOT DECAYED. An exponential decay would be smoother and
 * would also be unreadable at three in the morning: nobody can look at a
 * decayed float and say what happened. `window_started_at` says when these
 * counts began, and the whole row is rolled over once it is older than the
 * window. The arithmetic is addition and comparison, and that is on purpose.
 */

export type RouteHealthState = "available" | "busy" | "unavailable";

export type RouteHealth = {
  modelId: string;
  state: RouteHealthState;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  successes: number;
  failures: number;
  capacityErrors: number;
  /** Mean time to first token over the window, or null with no samples. */
  meanTtftMs: number | null;
  /** Mean output tokens per second over the window, or null with no samples. */
  meanThroughputTps: number | null;
  /** Whether measured latency puts this route below the interactive floor. */
  belowInteractiveFloor: boolean;
  /** Whether streaming is slow enough to deprioritise without hiding. */
  slowStreaming: boolean;
};

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A P50 time-to-first-token above this is dead for interactive chat.
 *
 * Thirty seconds is the product's stated floor and it is not a close call: a
 * reader mid-scene will have switched tabs. It is a deployment variable because
 * a deployment may want it tighter, never because it should be loosened to make
 * a bad route look acceptable.
 *
 * NOTE ON "P50". The window keeps a mean rather than a true median, because a
 * median needs the samples and this table keeps counters. A mean is the more
 * pessimistic statistic when a route occasionally stalls, which is the right
 * direction to be wrong in for a gate that hides routes.
 */
export function interactiveTtftCeilingMs() {
  return positiveNumber(process.env.ROUTE_MAX_TTFT_MS, 30_000);
}

/**
 * Streaming slower than this is unpleasant even when it starts promptly.
 *
 * A route that fails only this check is DEPRIORITISED, not hidden: fifteen
 * tokens a second is slow to read along with, and it is still a working model
 * that somebody may prefer to no model at all.
 */
export function slowStreamingFloorTps() {
  return positiveNumber(process.env.ROUTE_MIN_THROUGHPUT_TPS, 15);
}

/** How long a set of counts stands before it is rolled over. */
export function healthWindowMs() {
  return positiveNumber(process.env.ROUTE_HEALTH_WINDOW_MS, 60 * 60_000);
}

export type RouteOutcome = {
  modelId: string;
  ok: boolean;
  /** True for 429s and explicit capacity refusals. Counted apart from faults. */
  capacity?: boolean;
  ttftMs?: number | null;
  outputTokens?: number | null;
  generationMs?: number | null;
};

/**
 * Record what one request did to one route.
 *
 * Deliberately best-effort and deliberately silent on failure: this is
 * telemetry beside a reader's generation, and a health table that is briefly
 * unwritable must never be the reason a reply does not arrive.
 */
export async function recordRouteOutcome(outcome: RouteOutcome) {
  const windowMs = healthWindowMs();
  const ttft = Number.isFinite(Number(outcome.ttftMs)) && Number(outcome.ttftMs) >= 0 ? Math.round(Number(outcome.ttftMs)) : null;
  const outputTokens = Number.isFinite(Number(outcome.outputTokens)) && Number(outcome.outputTokens) > 0 ? Math.round(Number(outcome.outputTokens)) : null;
  const generationMs = Number.isFinite(Number(outcome.generationMs)) && Number(outcome.generationMs) > 0 ? Math.round(Number(outcome.generationMs)) : null;
  // Throughput needs both halves; one without the other is not a measurement.
  const throughputSample = outputTokens !== null && generationMs !== null;
  try {
    await query(
      `INSERT INTO model_route_health (model_id) VALUES ($1) ON CONFLICT (model_id) DO NOTHING`,
      [outcome.modelId],
    );
    /*
     * ROLL THE WINDOW OVER FIRST, in its own statement.
     *
     * Folding "reset if stale, then add" into one UPDATE with CASE expressions
     * is possible and is the kind of cleverness that produces a row where the
     * counts were reset and the sample was not added. Two statements, each
     * obviously correct, cost one round trip and can be read at a glance.
     */
    await query(
      `UPDATE model_route_health
          SET window_started_at=now(),successes=0,failures=0,capacity_errors=0,
              ttft_ms_total=0,ttft_samples=0,output_tokens_total=0,generation_ms_total=0
        WHERE model_id=$1 AND window_started_at < $2`,
      [outcome.modelId, new Date(Date.now() - windowMs).toISOString()],
    );
    await query(
      `UPDATE model_route_health SET
         successes = successes + $2,
         failures = failures + $3,
         capacity_errors = capacity_errors + $4,
         last_success_at = CASE WHEN $2 = 1 THEN now() ELSE last_success_at END,
         last_failure_at = CASE WHEN $3 = 1 THEN now() ELSE last_failure_at END,
         ttft_ms_total = ttft_ms_total + $5,
         ttft_samples = ttft_samples + $6,
         output_tokens_total = output_tokens_total + $7,
         generation_ms_total = generation_ms_total + $8,
         updated_at = now()
       WHERE model_id=$1`,
      [
        outcome.modelId,
        outcome.ok ? 1 : 0,
        outcome.ok ? 0 : 1,
        !outcome.ok && outcome.capacity ? 1 : 0,
        ttft ?? 0,
        ttft === null ? 0 : 1,
        throughputSample ? outputTokens : 0,
        throughputSample ? generationMs : 0,
      ],
    );
  } catch (error) {
    console.warn("[route-health] could not record an outcome", outcome.modelId, error instanceof Error ? error.message : error);
  }
}

type HealthRow = {
  model_id: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  successes: number;
  failures: number;
  capacity_errors: number;
  ttft_ms_total: string | number;
  ttft_samples: number;
  output_tokens_total: string | number;
  generation_ms_total: string | number;
};

/**
 * Turn a window of counts into the one word a reader sees.
 *
 * The rules, in the order they are applied, and each with a reason:
 *
 * NO EVIDENCE MEANS AVAILABLE. A route nobody has used today is not thereby
 * broken, and starting every new route as "unavailable" would mean a curated
 * route could never be tried at all.
 *
 * A RECENT SUCCESS OUTWEIGHS OLD FAILURES. If the route answered since the last
 * failure, whatever went wrong has passed. This is what lets a busy endpoint
 * recover the moment it recovers rather than after its counters age out.
 *
 * CAPACITY REFUSALS ARE THEIR OWN STATE. A route failing mostly on 429 is busy,
 * which is a true and useful thing to say about a free endpoint at peak, and
 * quite different from a route that is failing on 500s.
 */
export function healthState(row: {
  successes: number; failures: number; capacityErrors: number;
  lastSuccessAt: string | null; lastFailureAt: string | null;
}): RouteHealthState {
  const attempts = row.successes + row.failures;
  if (attempts === 0) return "available";
  if (row.lastSuccessAt && (!row.lastFailureAt || row.lastSuccessAt >= row.lastFailureAt)) return "available";
  const failureRate = row.failures / attempts;
  // A route still answering most of the time is not down; one bad reply in
  // three is unpleasant, not an outage, and hiding it would remove a working
  // model from somebody who was happily using it.
  if (failureRate < 0.5) return "available";
  return row.capacityErrors >= row.failures / 2 ? "busy" : "unavailable";
}

function summarize(row: HealthRow): RouteHealth {
  const ttftSamples = Number(row.ttft_samples) || 0;
  const meanTtftMs = ttftSamples > 0 ? Number(row.ttft_ms_total) / ttftSamples : null;
  const generationMs = Number(row.generation_ms_total) || 0;
  const outputTokens = Number(row.output_tokens_total) || 0;
  const meanThroughputTps = generationMs > 0 && outputTokens > 0 ? (outputTokens / generationMs) * 1000 : null;
  const state = healthState({
    successes: Number(row.successes) || 0,
    failures: Number(row.failures) || 0,
    capacityErrors: Number(row.capacity_errors) || 0,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
  });
  return {
    modelId: row.model_id,
    state,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    successes: Number(row.successes) || 0,
    failures: Number(row.failures) || 0,
    capacityErrors: Number(row.capacity_errors) || 0,
    meanTtftMs,
    meanThroughputTps,
    belowInteractiveFloor: meanTtftMs !== null && meanTtftMs > interactiveTtftCeilingMs(),
    slowStreaming: meanThroughputTps !== null && meanThroughputTps < slowStreamingFloorTps(),
  };
}

/** Health for the named routes, keyed by catalogue id. Missing means unmeasured. */
export async function routeHealth(modelIds: string[]): Promise<Map<string, RouteHealth>> {
  const wanted = modelIds.filter((id) => id);
  if (!wanted.length) return new Map();
  try {
    /*
     * An explicit placeholder list rather than `= ANY($1)`.
     *
     * The catalogue is a handful of routes, so the statement stays small, and
     * the array form is not portable across the in-memory parser that backs the
     * schema tests — which quietly returns NO ROWS rather than failing. A health
     * read that silently finds nothing is exactly the bug that would make every
     * route look permanently healthy.
     */
    const placeholders = wanted.map((_, index) => `$${index + 1}`).join(",");
    const rows = await query<HealthRow>(
      `SELECT model_id,last_success_at,last_failure_at,successes,failures,capacity_errors,
              ttft_ms_total,ttft_samples,output_tokens_total,generation_ms_total
         FROM model_route_health WHERE model_id IN (${placeholders})`,
      wanted,
    );
    return new Map(rows.rows.map((row) => [row.model_id, summarize(row)]));
  } catch (error) {
    // A health table that cannot be read must not take the catalogue down with
    // it: an unmeasured route is offered, which is the pre-health behaviour.
    console.warn("[route-health] could not read health", error instanceof Error ? error.message : error);
    return new Map();
  }
}
