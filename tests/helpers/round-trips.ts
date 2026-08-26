import type { Pool, PoolClient } from "pg";

/**
 * How many times a request talks to the database.
 *
 * Round trips, not statements, is the number that matters: a pooled remote
 * PostgreSQL charges network latency per `query()` call, so `BEGIN`,
 * `SET LOCAL ROLE` and `COMMIT` cost exactly what a `SELECT` costs. Counting
 * them here is what lets a performance claim in the sprint report be a
 * measurement rather than an opinion.
 *
 * `connections` is counted separately because a pool checkout is its own cost
 * and because a route that opens three transactions where one would do is a
 * different mistake from a route that runs three queries.
 */
export type RoundTripLog = {
  queries: string[];
  connections: number;
  reset(): void;
  /** Round trips, ignoring the ceremony, for reporting both figures. */
  statements(): string[];
};

const ceremony = /^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE|SELECT set_config)/i;

export function countRoundTrips(pool: Pool): RoundTripLog {
  const log: RoundTripLog = {
    queries: [],
    connections: 0,
    reset() { log.queries.length = 0; log.connections = 0; },
    statements() { return log.queries.filter((text) => !ceremony.test(text)); },
  };

  const record = (text: unknown) => {
    if (typeof text === "string") log.queries.push(text);
    else if (text && typeof text === "object" && typeof (text as { text?: unknown }).text === "string") log.queries.push((text as { text: string }).text);
  };

  // Some in-memory adapters hand the pool itself back as the client, so
  // instrumenting both would report every statement twice. The pool joins the
  // "already wrapped" set before anything else touches it.
  const wrapped = new WeakSet<object>([pool as unknown as object]);
  const originalQuery = pool.query.bind(pool);
  (pool as { query: unknown }).query = (...args: unknown[]) => { record(args[0]); return (originalQuery as (...a: unknown[]) => unknown)(...args); };

  // A pool may hand back the same client object on a later checkout, so each
  // one is instrumented exactly once. Wrapping it again per connect is how an
  // earlier version of this helper reported every statement four times.
  const originalConnect = pool.connect.bind(pool);
  (pool as { connect: unknown }).connect = async (...args: unknown[]) => {
    log.connections += 1;
    const client = await (originalConnect as (...a: unknown[]) => Promise<PoolClient>)(...args);
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const clientQuery = client.query.bind(client);
      (client as { query: unknown }).query = (...inner: unknown[]) => { record(inner[0]); return (clientQuery as (...a: unknown[]) => unknown)(...inner); };
    }
    return client;
  };

  return log;
}
