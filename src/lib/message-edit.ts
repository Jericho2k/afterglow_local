/**
 * WHAT FINISHING AN EDIT MEANS, WHEN THERE IS NOTHING AFTER IT.
 *
 * Editing a message in the middle of a story is a correction: the reply that
 * followed it was already written, the reader has read it, and rewriting the
 * turn underneath does not un-write it. Afterglow leaves those alone
 * deliberately — `truncateAfter: false` — because silently discarding
 * somebody's scene to regenerate it is the destructive reading of "edit".
 *
 * Editing the NEWEST message, when it is the reader's own and nothing has
 * answered it yet, is not a correction at all. It is the turn still being
 * composed. The reader typed something, watched the generation fail or leave,
 * fixed their sentence, and pressed Save — and then, before this, had to find
 * a second control to ask for the reply they were obviously waiting for. The
 * two-step is the whole complaint.
 *
 * So the rule is stated once, here, in terms a test can drive, rather than
 * inferred from indices at the call site:
 *
 *   THE EDITED MESSAGE IS THE READER'S OWN. Editing a character's reply is
 *   authoring, not asking; the reader has said what they wanted it to say.
 *
 *   IT IS THE NEWEST MESSAGE IN THE STORY. Which is the same condition as "no
 *   assistant reply exists after it", stated in the form the transcript can
 *   actually answer.
 *
 * Everything else — an older turn, a message with a reply after it, an
 * assistant message anywhere — saves and stops, exactly as it did before.
 */

/** As much of a message as this decision needs. */
export type EditedMessage = { id: string; role: "user" | "assistant" };

/**
 * Whether saving this edit should generate the reply that is missing.
 *
 * `messages` is the transcript AS THE READER SEES IT, which is a window of the
 * newest messages rather than the whole story — and that is exactly the right
 * input, because the window always ends at the newest message. Earlier turns
 * are prepended by "Load earlier" and can only ever appear before what is
 * already here, so the last element is the end of the story whether or not the
 * beginning of it has been loaded.
 */
export function editTriggersGeneration(messages: readonly EditedMessage[], editedMessageId: string) {
  const newest = messages.at(-1);
  if (!newest) return false;
  // Not the last message: something already answers it, or something else is
  // being corrected. Either way the reader did not ask for a new reply.
  if (newest.id !== editedMessageId) return false;
  return newest.role === "user";
}

/**
 * ONE GENERATION AT A TIME, DECIDED SYNCHRONOUSLY.
 *
 * The chat panel already refuses to generate while `streaming` is true, and
 * that is not sufficient for this. `streaming` is React state: two taps on Save
 * landing in the same tick both read the value from the render they closed
 * over, both see `false`, and both start a turn. The reader gets two replies,
 * two bills and a transcript that has to be repaired.
 *
 * A claim answers in the same statement it is made, so the second caller loses
 * whatever React has or has not re-rendered. It lives in a ref rather than in
 * state for the same reason: state is what created the race.
 *
 * `release` is deliberately unconditional — it belongs in a `finally`, so a
 * failed generation frees the gate exactly like a successful one. A gate that
 * only opens on success is a chat that stops answering after its first error.
 */
export type GenerationGate = { pending: boolean };

export function idleGenerationGate(): GenerationGate {
  return { pending: false };
}

/** True when this caller may generate. False when somebody else already is. */
export function claimGeneration(gate: GenerationGate) {
  if (gate.pending) return false;
  gate.pending = true;
  return true;
}

export function releaseGeneration(gate: GenerationGate) {
  gate.pending = false;
}
