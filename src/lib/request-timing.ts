/**
 * WHERE THE TIME IN ONE WRITER TURN ACTUALLY GOES.
 *
 * The report is "some messages take close to a minute", and the reflex is to
 * blame the model. That may be most of it, but nobody knew, because the whole
 * request between "tap send" and "first token" was unmeasured: fifteen or so
 * serial database round trips, an embedding call, provider selection and a
 * connection handshake, all of them invisible.
 *
 * A timeline you can read is the prerequisite for fixing any of it, and it is
 * worth keeping afterwards — the same instrument that finds a regression is the
 * one that proves a fix worked. The overhead is a few `Date.now()` calls and one
 * log line.
 *
 * WHAT IT MAY NOT DO. It records STAGE NAMES AND DURATIONS ONLY: never prompt
 * text, never memory content, never a reader's message, never a key. A timing
 * log is an operational artifact and must stay safe to ship to a log drain.
 */

export type TimingMark = { stage: string; at: number };

export type RequestTimeline = {
  mark: (stage: string) => void;
  /** Runs `work`, marking when it finishes. Returns exactly what `work` returns. */
  measure: <T>(stage: string, work: () => Promise<T>) => Promise<T>;
  marks: TimingMark[];
  startedAt: number;
  /** Milliseconds from the start of the request to each mark, in order. */
  summary: () => { total: number; stages: Array<{ stage: string; at: number; delta: number }> };
};

export function startTimeline(): RequestTimeline {
  const startedAt = Date.now();
  const marks: TimingMark[] = [];
  const mark = (stage: string) => { marks.push({ stage, at: Date.now() - startedAt }); };
  const measure = async <T>(stage: string, work: () => Promise<T>) => {
    const result = await work();
    mark(stage);
    return result;
  };
  const summary = () => {
    let previous = 0;
    const stages = marks.map((item) => {
      const delta = item.at - previous;
      previous = item.at;
      return { stage: item.stage, at: item.at, delta };
    });
    return { total: marks.length ? marks[marks.length - 1].at : 0, stages };
  };
  return { mark, measure, marks, startedAt, summary };
}

/**
 * Whether to emit the timeline.
 *
 * Off by default so ordinary production logs are not one line per reply. Turned
 * on by an operator when they are looking, and always on in development, where
 * the whole point is to see the shape of a request while changing it.
 */
export function timingDiagnosticsEnabled() {
  if (process.env.CHAT_TIMING_DIAGNOSTICS === "1") return true;
  if (process.env.CHAT_TIMING_DIAGNOSTICS === "0") return false;
  return process.env.NODE_ENV === "development";
}

/**
 * One line, structured, with the slowest stage named.
 *
 * The slowest stage is called out because the question being asked of this log
 * is always "what do I fix first", and scanning fifteen deltas by eye is how
 * that question goes unanswered.
 */
export function logTimeline(timeline: RequestTimeline, context: Record<string, string | number | boolean | null | undefined> = {}) {
  if (!timingDiagnosticsEnabled()) return;
  const { total, stages } = timeline.summary();
  const slowest = stages.reduce((worst, item) => (item.delta > (worst?.delta ?? -1) ? item : worst), stages[0]);
  console.info("[timing] writer turn", JSON.stringify({
    ...context,
    totalMs: total,
    slowestStage: slowest?.stage ?? null,
    slowestMs: slowest?.delta ?? 0,
    stages: stages.map((item) => `${item.stage}=${item.delta}`),
  }));
}
