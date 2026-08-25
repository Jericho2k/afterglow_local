/**
 * The window a usage report covers.
 *
 * "All time" and "today" were the only two answers available, and neither tells
 * an operator what they actually want to know — whether last week cost more
 * than the week before, what a change to the prompt did to the bill, which
 * model is expensive at the volume it is being used at now rather than since
 * the account was created.
 *
 * Two decisions worth stating.
 *
 * A DAY IS THE READER'S DAY. "Today" and "this month" are wall-clock ideas and
 * the server has no idea what wall clock the reader is on, so the browser sends
 * its offset and the boundaries are computed against that. Without it a report
 * read at 9am in Auckland would show yesterday.
 *
 * A RANGE IS A HALF-OPEN INTERVAL. `[from, to)`, always. An inclusive end date
 * is what the reader means and a half-open interval is what makes the SQL
 * correct at midnight, so the conversion happens here, once, rather than in
 * every query.
 */

export const usageRangeIds = ["today", "7d", "30d", "month", "all", "custom"] as const;
export type UsageRangeId = (typeof usageRangeIds)[number];

export type ResolvedUsageRange = {
  id: UsageRangeId;
  label: string;
  /** Inclusive start, or null for "since the beginning". */
  from: Date | null;
  /** Exclusive end, or null for "up to now". */
  to: Date | null;
};

/** The furthest back a custom range may reach. Guards a pathological query. */
export const maxCustomRangeDays = 1_100;

function isRangeId(value: string | null): value is UsageRangeId {
  return Boolean(value) && (usageRangeIds as readonly string[]).includes(value as string);
}

/** Minutes to add to local time to get UTC, as `Date.getTimezoneOffset()` gives it. */
function normalizedOffset(raw: string | null) {
  const value = Number(raw);
  // Anything beyond a day is not a timezone; fall back to UTC rather than to
  // an arbitrary shift.
  return Number.isFinite(value) && Math.abs(value) <= 900 ? value : 0;
}

/** Midnight at the start of the reader's day containing `at`. */
function startOfLocalDay(at: Date, offsetMinutes: number) {
  const shifted = new Date(at.getTime() - offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + offsetMinutes * 60_000);
}

function startOfLocalMonth(at: Date, offsetMinutes: number) {
  const shifted = new Date(at.getTime() - offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(1);
  return new Date(shifted.getTime() + offsetMinutes * 60_000);
}

const day = 86_400_000;

/** A `YYYY-MM-DD` from the reader, as an instant in their own day. */
function parseLocalDate(raw: string | null, offsetMinutes: number) {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + offsetMinutes * 60_000);
}

export function resolveUsageRange(params: URLSearchParams, now = new Date()): ResolvedUsageRange {
  const offset = normalizedOffset(params.get("offset"));
  const requested = params.get("range");
  const id: UsageRangeId = isRangeId(requested) ? requested : "all";
  const today = startOfLocalDay(now, offset);

  if (id === "today") return { id, label: "Today", from: today, to: null };
  // "Last 7 days" includes today, so it starts six days ago. Reading it as the
  // seven days BEFORE today is the other reasonable definition and the wrong
  // one: a report that never contains this morning is not what anybody means.
  if (id === "7d") return { id, label: "Last 7 days", from: new Date(today.getTime() - 6 * day), to: null };
  if (id === "30d") return { id, label: "Last 30 days", from: new Date(today.getTime() - 29 * day), to: null };
  if (id === "month") return { id, label: "This month", from: startOfLocalMonth(now, offset), to: null };
  if (id === "custom") {
    const from = parseLocalDate(params.get("from"), offset);
    const rawTo = parseLocalDate(params.get("to"), offset);
    // The reader's end date is inclusive; the interval is not.
    const to = rawTo ? new Date(rawTo.getTime() + day) : null;
    if (!from || !to || to <= from || to.getTime() - from.getTime() > maxCustomRangeDays * day) {
      return { id: "all", label: "All time", from: null, to: null };
    }
    return { id, label: "Custom range", from, to };
  }
  return { id: "all", label: "All time", from: null, to: null };
}

/**
 * The range as a SQL predicate and its parameters.
 *
 * Built rather than parameterised with nullable bounds, because a predicate
 * that is present only when it applies is one an index can use — and
 * `usage_events (user_id, created_at DESC)` already exists, so no migration is
 * needed for any of this.
 */
export function usageRangeFilter(userId: string, range: ResolvedUsageRange) {
  const values: unknown[] = [userId];
  let predicate = "user_id=$1";
  if (range.from) { values.push(range.from.toISOString()); predicate += ` AND created_at >= $${values.length}`; }
  if (range.to) { values.push(range.to.toISOString()); predicate += ` AND created_at < $${values.length}`; }
  return { predicate, values };
}
