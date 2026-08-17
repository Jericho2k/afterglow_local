import type { Message } from "./types";

// A conservative approximation for English prose and roleplay punctuation.
// The provider reports real usage after each request; this estimate is only used
// to keep the rolling transcript inside the configured prompt budget.
export function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function selectRecentMessages(messages: Message[], maxMessages: number, tokenBudget: number) {
  const candidates = messages.slice(-Math.max(1, maxMessages));
  const selected: Message[] = [];
  let used = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const cost = estimateTokens(message.content) + 8;
    // Preserve at least the last exchange even when a single very long message
    // exceeds the estimate; otherwise continuation and regeneration lose the scene.
    if (selected.length >= 2 && used + cost > tokenBudget) break;
    selected.unshift(message);
    used += cost;
  }

  return selected;
}

export function recallText(messages: Message[], fallback = "") {
  const recent = messages.slice(-8).map((message) => `${message.role}: ${message.content}`).join("\n");
  return recent || fallback;
}
