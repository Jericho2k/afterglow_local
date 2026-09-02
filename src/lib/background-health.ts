import { userQuery } from "./db";
import type { BackgroundTask } from "./background-routing";

/**
 * DID THE BACKGROUND WORK ACTUALLY HAPPEN?
 *
 * Nothing in the product could answer that, and the way it was discovered is
 * the whole argument for this file: a reader chatted normally for a while and
 * found out much later that the conversation had NO MEMORIES. Every
 * consolidation had failed, every failure had been logged to a console nobody
 * was watching, and the chat request — which is deliberately not coupled to
 * background work — was correct and cheerful throughout.
 *
 * The usage ledger cannot answer it either, and that is not an oversight in the
 * ledger. A usage row exists when a model ran and reported tokens; a run of
 * empty responses, a run of 429s and a route that was never selectable all
 * produce the same thing there, which is nothing. Absence of evidence looks
 * exactly like absence of work.
 *
 * So success and failure are both RECORDED, per conversation and per job, with
 * the smallest set of facts that answers an operator's actual questions: is it
 * working, when did it last work, what broke, how many times in a row, and did
 * the fallback have to save it.
 *
 * WHAT IS DELIBERATELY NOT HERE. No prompt, no transcript, no model output, no
 * upstream body. A failure is a CATEGORY — `empty_response`, `rate_limited` —
 * because that is what decides what an operator does next, and because this row
 * is rendered in a browser. The detailed body stays in `ProviderError.diagnostic`
 * and goes to the server log alone.
 *
 * It is written on a best-effort basis and never throws: a health row that
 * cannot be saved must not be the thing that fails a memory job.
 */

export type BackgroundJobHealth = {
  task: BackgroundTask;
  lastSuccessAt: string | null;
  lastSuccessModel: string;
  lastSuccessCandidate: string | null;
  lastFailureAt: string | null;
  lastFailureModel: string;
  lastFailureCandidate: string | null;
  /** A ProviderError category, or one of this module's own. Never a body. */
  lastFailureReason: string;
  /** Resets to zero on any success. The number an operator actually reads. */
  consecutiveFailures: number;
  /** Whether the most recent SUCCESS was the control answering for a failure. */
  lastSuccessUsedFallback: boolean;
};

function healthFromRow(row: Record<string, unknown>): BackgroundJobHealth {
  return {
    task: String(row.task) as BackgroundTask,
    lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)).toISOString() : null,
    lastSuccessModel: String(row.last_success_model || ""),
    lastSuccessCandidate: row.last_success_candidate ? String(row.last_success_candidate) : null,
    lastFailureAt: row.last_failure_at ? new Date(String(row.last_failure_at)).toISOString() : null,
    lastFailureModel: String(row.last_failure_model || ""),
    lastFailureCandidate: row.last_failure_candidate ? String(row.last_failure_candidate) : null,
    lastFailureReason: String(row.last_failure_reason || ""),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastSuccessUsedFallback: Boolean(row.last_success_used_fallback),
  };
}

/**
 * A job ran and produced what it was asked for.
 *
 * `usedFallback` is stored on the SUCCESS rather than on the failure it
 * followed, because the question an operator asks is "is memory being written,
 * and by what" — and "yes, but only because the control keeps rescuing the
 * route you selected" is a different answer from "yes".
 */
export async function recordBackgroundSuccess(
  userId: string,
  conversationId: string,
  input: { task: BackgroundTask; model: string; candidateId: string | null; usedFallback?: boolean },
) {
  await userQuery(
    userId,
    `INSERT INTO background_job_health
       (conversation_id,user_id,task,last_success_at,last_success_model,last_success_candidate,
        last_success_used_fallback,consecutive_failures,updated_at)
     VALUES ($1,$2,$3,now(),$4,$5,$6,0,now())
     ON CONFLICT (conversation_id,task) DO UPDATE SET
       last_success_at=now(),
       last_success_model=EXCLUDED.last_success_model,
       last_success_candidate=EXCLUDED.last_success_candidate,
       last_success_used_fallback=EXCLUDED.last_success_used_fallback,
       -- A success is what makes a streak a streak. Everything about the last
       -- failure is kept: an operator needs to see what has been going wrong
       -- even on a job that recovered.
       consecutive_failures=0,
       updated_at=now()`,
    [conversationId, userId, input.task, input.model, input.candidateId, input.usedFallback === true],
  ).catch((error) => console.error("[background-health] could not record a success", error));
}

/** A job could not produce what it was asked for. `reason` is a category. */
export async function recordBackgroundFailure(
  userId: string,
  conversationId: string,
  input: { task: BackgroundTask; model: string; candidateId: string | null; reason: string },
) {
  await userQuery(
    userId,
    `INSERT INTO background_job_health
       (conversation_id,user_id,task,last_failure_at,last_failure_model,last_failure_candidate,
        last_failure_reason,consecutive_failures,updated_at)
     VALUES ($1,$2,$3,now(),$4,$5,$6,1,now())
     ON CONFLICT (conversation_id,task) DO UPDATE SET
       last_failure_at=now(),
       last_failure_model=EXCLUDED.last_failure_model,
       last_failure_candidate=EXCLUDED.last_failure_candidate,
       last_failure_reason=EXCLUDED.last_failure_reason,
       consecutive_failures=background_job_health.consecutive_failures+1,
       updated_at=now()`,
    [conversationId, userId, input.task, input.model, input.candidateId, input.reason.slice(0, 60)],
  ).catch((error) => console.error("[background-health] could not record a failure", error));
}

/** Every job's health for one conversation. Empty on any read failure. */
export async function backgroundJobHealth(userId: string, conversationId: string) {
  try {
    const result = await userQuery(userId, "SELECT * FROM background_job_health WHERE conversation_id=$1 AND user_id=$2", [conversationId, userId]);
    return new Map(result.rows.map((row) => {
      const health = healthFromRow(row as Record<string, unknown>);
      return [health.task, health] as const;
    }));
  } catch (error) {
    console.warn("[background-health] could not be read", error instanceof Error ? error.message : error);
    return new Map<BackgroundTask, BackgroundJobHealth>();
  }
}

/**
 * WHAT THE OPERATOR IS TOLD, IN ONE SENTENCE OR NONE.
 *
 * Two conditions, and the second is the one that catches the failure that
 * started all this. A run of consecutive failures is loud and easy. A job that
 * is simply NOT ADVANCING is quiet: no failures recorded because nothing is
 * being attempted, or attempts that fail before they reach a model, while the
 * story keeps growing. Both end in a conversation with no memories, so both
 * have to produce a warning.
 *
 * `null` means there is nothing to say, which must stay the common case — a
 * panel that always shows a warning is a panel nobody reads.
 */
export function memoryWarning(input: {
  health: BackgroundJobHealth | undefined;
  /** Accepted messages this story has. */
  messageCount: number;
  /** How far consolidation has actually got through them. */
  consolidatedCount: number;
  /** The interval consolidation waits for before it runs at all. */
  consolidationInterval: number;
}) {
  const failures = input.health?.consecutiveFailures ?? 0;
  if (failures >= 3) {
    return `Memory extraction has failed ${failures} times in a row (${input.health?.lastFailureReason || "unknown reason"}). This story is not gaining new memories.`;
  }
  if (failures > 0) {
    return `The last memory extraction failed (${input.health?.lastFailureReason || "unknown reason"}). One more failure and this story will start losing continuity.`;
  }
  /*
   * The silent case. Two full intervals of unconsolidated story is well past
   * anything the trigger's own token gate explains, so the job is either not
   * running or failing before it records anything.
   */
  const behind = input.messageCount - input.consolidatedCount;
  if (behind >= input.consolidationInterval * 2 && input.messageCount >= input.consolidationInterval * 2) {
    return `${behind} messages have not been consolidated yet. Memory extraction may not be running for this story.`;
  }
  return null;
}
