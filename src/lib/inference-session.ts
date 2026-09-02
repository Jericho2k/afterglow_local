import { createHash } from "node:crypto";
import type { InferenceTask } from "./provider";

/**
 * Provider session identity.
 *
 * OpenRouter uses a request's `session_id` to keep sequential turns on the
 * upstream host that already holds their prompt cache. Without one, stickiness
 * only begins after a cache hit has been observed — which for a long roleplay
 * is precisely the turn where the money was already spent.
 *
 * Three rules govern what is sent.
 *
 * IT IS STABLE. The same conversation produces the same identifier on every
 * turn, for as long as the conversation exists. A random value per request
 * would be worse than sending nothing: it asks for stickiness and then defeats
 * it.
 *
 * IT IS SCOPED TO ONE TASK. Roleplay generation, Scene State extraction and
 * memory maintenance have completely different prompt prefixes, so grouping
 * them under one identifier would ask a provider to hold a cache that can
 * never hit. Each task therefore has its own namespace, and one account-wide
 * identifier is never sent.
 *
 * IT CARRIES NOTHING. The value is a truncated SHA-256 of a deployment salt,
 * the task name and the resource id. It is opaque, contains no account, email,
 * character or conversation identifier, and cannot be reversed into one by
 * whoever reads a provider log.
 */

/** Tasks whose turns share a prompt prefix worth keeping warm. */
const stickyTasks: Record<InferenceTask, boolean> = {
  // The long one. A roleplay turn resends the character, world, persona and
  // rules unchanged, which is exactly what a warm cache is for.
  rp_generation: true,
  // Also conversation-shaped: the extraction prompt is stable and the
  // transcript it reads grows at the end.
  scene_state: true,
  /*
   * CONSOLIDATION IS STICKY TOO, AND THE OLD REASONING WAS ABOUT THE OLD PROMPT.
   *
   * "The prefix is different every time" was true when the extraction rules and
   * the JSON schema sat at the END of a single user message, behind the
   * transcript: every call diverged on its first line and there was nothing for
   * a host to hold. That prompt no longer exists. The rules and the schema are
   * a system message that is byte-identical on every consolidation this
   * deployment ever makes, and the varying material — summary, commitments,
   * transcript — follows it.
   *
   * Roughly a thousand tokens of stable prefix per call is worth keeping warm
   * on one host, and DeepSeek prices a cached input token at about a fiftieth
   * of a fresh one. Without a session id, stickiness only begins after a cache
   * hit has been observed, and consolidations for one story are minutes apart —
   * which is exactly the interval over which a host is most likely to be
   * reassigned.
   */
  memory_consolidation: true,
  /*
   * Curation stays unsticky, and the reason is its CADENCE rather than its
   * prompt.
   *
   * Its instruction block is stable and does sit at the head of what it sends,
   * so a cache could hold it in principle. But canon is curated once every 75 to
   * 150 messages — hours or days apart in a real story — and no provider holds a
   * prompt cache over that interval. A session id would ask a host to be sticky
   * across a gap in which the cache has certainly expired, which buys nothing
   * and gives up the freedom to route each run to whatever is healthy. If the
   * curation interval ever drops to minutes this line should be revisited.
   */
  memory_curation: false,
  // A one-shot task with no follow-up turn to be sticky with.
  character_import: false,
};

function salt() {
  return process.env.OPENROUTER_SESSION_SALT?.trim() || "afterglow-inference-session";
}

/**
 * The identifier for one task on one resource, or undefined when this task
 * has nothing to gain from stickiness.
 */
export function inferenceSessionId(task: InferenceTask, resourceId: string | null | undefined) {
  if (!stickyTasks[task] || !resourceId) return undefined;
  return createHash("sha256").update(`${salt()}:${task}:${resourceId}`).digest("hex").slice(0, 32);
}
