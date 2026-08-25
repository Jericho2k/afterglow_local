import type { LLMMessage } from "./llm";
import { estimateTokens } from "./context";

/**
 * What a writer prompt is actually made of.
 *
 * Every claim in this sprint about cost — that Worlds dominate a long prompt,
 * that the transcript is not the expensive part, that a particular block is
 * what breaks prefix caching — is a claim about a specific number of tokens in
 * a specific place. This file produces those numbers from the exact string the
 * provider was handed, so a measurement can never drift away from what was
 * sent.
 *
 * It deliberately does NOT rebuild the prompt from its inputs. A second
 * assembler would be a second thing to keep in step with `roleplayPrompt`, and
 * the first time they disagreed the measurement would be the one that lied.
 * Instead the assembled prompt is PARTITIONED at its own section headers: each
 * section is a half-open range of the original string, the ranges are
 * contiguous, and their lengths sum to the whole. `analyzeSystemPrompt` asserts
 * that, so a renamed header shows up as an accounting failure rather than as a
 * quietly wrong report.
 */

export type PromptSectionId =
  | "intro" | "engine" | "creation" | "cast" | "userRole" | "world" | "persona"
  | "chatInstructions" | "rules" | "adultMode" | "responseLength" | "precedence"
  | "continuityHeader" | "scene" | "canon" | "summary" | "memories" | "arcs";

export type PromptSection = { id: PromptSectionId; label: string; chars: number; tokens: number };

/**
 * The headers, in the order `roleplayPrompt` emits them.
 *
 * Each entry is matched at a line start at or after the previous match, so a
 * character's backstory that happens to contain the word RULES cannot open a
 * section. Optional entries are simply absent when the prompt did not include
 * them — a creation with no cast, a chat with Scene State off.
 */
const markers: Array<{ id: PromptSectionId; label: string; patterns: string[] }> = [
  { id: "engine", label: "Engine (roleplay preset)", patterns: ["ROLEPLAY PRESET"] },
  { id: "creation", label: "Creation definition", patterns: ["CHARACTER\n", "SCENARIO\n"] },
  { id: "cast", label: "Cast definitions", patterns: ["STRUCTURED CAST", "IMPORTANT CHARACTERS"] },
  { id: "userRole", label: "User's role", patterns: ["THE USER'S ROLE IN THIS STORY"] },
  { id: "world", label: "World lore", patterns: ["LOREBOOK / WORLD CANON"] },
  { id: "persona", label: "Persona", patterns: ["ACTIVE USER PERSONA FOR THIS STORY"] },
  { id: "chatInstructions", label: "Chat instructions", patterns: ["CHAT-SPECIFIC INSTRUCTIONS"] },
  { id: "rules", label: "Base rules", patterns: ["RULES\n"] },
  { id: "adultMode", label: "Adult/SFW mode", patterns: ["ADULT MODE:", "SFW MODE:"] },
  { id: "responseLength", label: "Response length", patterns: ["RESPONSE LENGTH — "] },
  { id: "precedence", label: "Continuity precedence", patterns: ["CONTINUITY PRECEDENCE FOR FACTS"] },
  { id: "continuityHeader", label: "Continuity header", patterns: ["CURRENT CONTINUITY — DYNAMIC FOR THIS REPLY"] },
  { id: "scene", label: "Scene state", patterns: ["CURRENT SCENE"] },
  { id: "canon", label: "Core canon", patterns: ["Core canon — foundational facts"] },
  { id: "summary", label: "Rolling summary", patterns: ["Rolling state and story-so-far:"] },
  { id: "memories", label: "Episodic memories", patterns: ["Relevant durable memories"] },
  { id: "arcs", label: "Historical arcs", patterns: ["Relevant historical arcs"] },
];

/** The first line-anchored occurrence of any pattern at or after `from`. */
function findMarker(text: string, patterns: string[], from: number) {
  let best = -1;
  for (const pattern of patterns) {
    let at = text.indexOf(pattern, from);
    while (at !== -1) {
      if (at === 0 || text[at - 1] === "\n") { if (best === -1 || at < best) best = at; break; }
      at = text.indexOf(pattern, at + 1);
    }
  }
  return best;
}

export function analyzeSystemPrompt(system: string) {
  const bounds: Array<{ id: PromptSectionId; label: string; start: number }> = [
    { id: "intro", label: "System intro", start: 0 },
  ];
  let cursor = 0;
  for (const marker of markers) {
    const at = findMarker(system, marker.patterns, cursor);
    if (at === -1) continue;
    bounds.push({ id: marker.id, label: marker.label, start: at });
    cursor = at + 1;
  }
  const sections: PromptSection[] = bounds.map((bound, index) => {
    const end = index + 1 < bounds.length ? bounds[index + 1].start : system.length;
    const text = system.slice(bound.start, end);
    return { id: bound.id, label: bound.label, chars: text.length, tokens: estimateTokens(text) };
  });
  const accounted = sections.reduce((sum, section) => sum + section.chars, 0);
  // The partition is the guarantee. If this ever fails a header was renamed and
  // the breakdown below it would have been silently attributed to its
  // predecessor.
  if (accounted !== system.length) throw new Error(`Prompt partition lost ${system.length - accounted} characters`);
  return { sections, chars: system.length, tokens: estimateTokens(system) };
}

/**
 * The whole request, not just the system message.
 *
 * `stablePrefixChars` is the honest version of "how much of this could a
 * provider have reused": the number of leading characters this payload shares
 * with the previous one, measured over the same serialisation a provider sees.
 */
export function analyzePayload(messages: LLMMessage[]) {
  const system = messages[0]?.role === "system" ? messages[0].content : "";
  const rest = messages.slice(system ? 1 : 0);
  const transcriptChars = rest.reduce((sum, message) => sum + message.content.length, 0);
  return {
    system: analyzeSystemPrompt(system),
    transcript: { messages: rest.length, chars: transcriptChars, tokens: estimateTokens(rest.map((m) => m.content).join("\n")) },
    chars: system.length + transcriptChars,
    tokens: estimateTokens(system) + estimateTokens(rest.map((m) => m.content).join("\n")),
  };
}

/** One request, flattened exactly as a provider reads it: role then content. */
export function serializePayload(messages: LLMMessage[]) {
  return messages.map((message) => `<${message.role}>${message.content}`).join("\n");
}

/**
 * How much of turn N+1 a provider could serve from turn N's cache.
 *
 * Character-level rather than token-level on purpose: tokenisation is
 * provider-specific, the ratio is what matters, and a character prefix is a
 * strict lower bound on the token prefix.
 */
export function sharedPayloadPrefix(previous: LLMMessage[], next: LLMMessage[]) {
  const before = serializePayload(previous);
  const after = serializePayload(next);
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared += 1;
  return { sharedChars: shared, previousChars: before.length, nextChars: after.length, ratio: before.length ? shared / before.length : 1 };
}

/** Where the two payloads stop agreeing, named by the section it lands in. */
export function firstDivergentSection(previous: LLMMessage[], next: LLMMessage[]) {
  const { sharedChars } = sharedPayloadPrefix(previous, next);
  const system = previous[0]?.role === "system" ? previous[0].content : "";
  // The serialisation prefixes the system message with "<system>".
  const offset = sharedChars - "<system>".length;
  if (offset < 0) return "intro";
  if (offset >= system.length) return "transcript";
  const { sections } = analyzeSystemPrompt(system);
  let start = 0;
  for (const section of sections) {
    if (offset < start + section.chars) return section.id;
    start += section.chars;
  }
  return "transcript";
}

/** A fixed-width table, for reports that have to be read rather than parsed. */
export function renderBreakdown(title: string, sections: PromptSection[], totalTokens: number) {
  const width = Math.max(...sections.map((section) => section.label.length), 20);
  const rows = sections
    .filter((section) => section.tokens > 0)
    .map((section) => `${section.label.padEnd(width)}  ${String(section.tokens).padStart(7)}  ${((section.tokens / totalTokens) * 100).toFixed(1).padStart(5)}%`);
  return [`${title} — ${totalTokens.toLocaleString()} tokens`, ...rows].join("\n");
}
