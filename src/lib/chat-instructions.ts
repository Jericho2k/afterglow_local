import type { ChatInstructionPreset } from "./types";

/**
 * What "instructions" means, in one place.
 *
 * The number beside the Instructions control disagreed with itself: the strip
 * above the composer counted the presets plus the custom text, while the
 * control that opened the panel counted only the presets. Two call sites, two
 * definitions, and a custom instruction that was active in the prompt while the
 * button said it did not exist.
 *
 * There is only one definition, and it is the one the writer actually receives:
 * a requirement is active when it is a selected preset, or when the custom
 * field holds something other than whitespace. Every counter, label and badge
 * reads it from here.
 */

export type ChatInstructionState = {
  instructionPresets: ChatInstructionPreset[];
  customInstructions: string;
};

/** Whether the custom field currently says anything at all. */
export function hasCustomInstruction(custom: string | null | undefined) {
  return Boolean(custom && custom.trim());
}

/** How many active requirements this conversation carries. */
export function activeInstructionCount(state: Partial<ChatInstructionState> | null | undefined) {
  const presets = state?.instructionPresets?.length ?? 0;
  return presets + (hasCustomInstruction(state?.customInstructions) ? 1 : 0);
}

/** The short label the composer strip and the story panel both show. */
export function instructionSummary(state: Partial<ChatInstructionState> | null | undefined) {
  const count = activeInstructionCount(state);
  if (!count) return "None active";
  return `${count} active`;
}

/**
 * The presets, with the copy the panel shows for each.
 *
 * Kept beside the counter rather than inline in the panel so that adding a
 * preset cannot accidentally add one the count does not know about.
 */
export const instructionChoices: { id: ChatInstructionPreset; title: string; description: string }[] = [
  { id: "reduce_repetition", title: "Reduce repetition", description: "Rewrite repeated openings, gestures, phrasing and beats before replying." },
  { id: "stay_focused", title: "Stay focused", description: "Keep the reply on the current scene instead of opening side plots." },
  { id: "advance_plot", title: "Advance plot", description: "Add a concrete new beat, consequence or complication when the moment allows." },
];
