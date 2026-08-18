import { describe, expect, it } from "vitest";
import { recallText, selectRecentMessages } from "@/lib/context";
import type { Message } from "@/lib/types";

const message = (id: string, role: Message["role"], content: string): Message => ({
  id, conversationId: "conversation", role, content, variants: role === "assistant" ? [content] : [],
  selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: new Date().toISOString(),
});

describe("rolling context", () => {
  it("keeps the newest complete exchange inside a token budget", () => {
    const messages = [message("old", "user", "x".repeat(4000)), message("a", "assistant", "Current scene"), message("u", "user", "Continue")];
    expect(selectRecentMessages(messages, 30, 100).map((item) => item.id)).toEqual(["a", "u"]);
  });

  it("uses assistant scene context for short continuation-like user turns", () => {
    const value = recallText([message("a", "assistant", "They are standing beside the closed restaurant."), message("u", "user", "Yes.")]);
    expect(value).toContain("closed restaurant");
    expect(value).toContain("Yes.");
  });
});
