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
  // Maintenance runs on a schedule against a rewritten window; the prefix is
  // different every time, so stickiness would pin a host for no benefit.
  memory_consolidation: false,
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
