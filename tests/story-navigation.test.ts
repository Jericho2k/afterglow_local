import { describe, expect, it } from "vitest";
import { closeStorySurface, openChatChild, openStory, openStoryChild } from "@/lib/story-navigation";

describe("Story navigation", () => {
  it("returns nested tools to Story", () => {
    for (const child of ["model","instructions","persona","world"] as const) {
      expect(closeStorySurface(openStoryChild(child))).toEqual(openStory());
    }
  });

  it("returns composer tools directly to chat", () => {
    expect(closeStorySurface(openChatChild("model"))).toMatchObject({surface:"closed",parent:"chat"});
  });
});
