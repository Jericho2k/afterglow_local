import { describe, expect, it } from "vitest";
import {
  addImage, addTextSection, collapseIfPlain, editorStateFrom, hasImages,
  moveBlock, removeBlock, setBlockText, setCaption, storedValue,
} from "@/components/rich/editor-state";
import { normalizeBlocks } from "@/lib/rich-content";

/**
 * The bug this file exists for.
 *
 * "Add a text section" appended an empty text block and then handed the list
 * to the function whose job is to delete empty text blocks, so the button
 * worked and produced nothing. The fix is a separation — editing state may
 * hold an empty paragraph, stored state may not — and these tests assert both
 * halves, including the full round trip a creator actually performs: write,
 * illustrate, add a paragraph, type into it, save, reopen.
 *
 * The editor is shared by world lore, creation descriptions and opening
 * messages, so fixing it here fixes it in all three; the last test walks each
 * of those shapes through the same sequence.
 */

describe("adding a text section", () => {
  it("produces a paragraph that survives long enough to be typed into", () => {
    let state = editorStateFrom([], "The tower has stood for nine hundred years.");
    state = addImage(state, "users/a/tower.png");
    // Reset to just the image, so the next assertion is about the button and
    // not about the paragraph an image insert already adds.
    state = removeBlock(state, state.length - 1);
    const before = state.length;

    state = addTextSection(state);

    // This is the whole complaint: the block must be there, and it must be an
    // empty text block ready to receive a cursor.
    expect(state).toHaveLength(before + 1);
    expect(state[state.length - 1]).toEqual({ type: "text", text: "" });
    // And normalisation — which is what used to eat it — still would.
    expect(normalizeBlocks(state)).toHaveLength(before);
  });

  it("does not lose the box when the last character is deleted", () => {
    let state = editorStateFrom([], "Opening line.");
    state = addImage(state, "users/a/one.png");
    state = setBlockText(state, 2, "A second paragraph.");
    const count = state.length;

    state = setBlockText(state, 2, "");
    expect(state).toHaveLength(count);
    expect(state[2]).toEqual({ type: "text", text: "" });
  });

  it("still refuses to persist a paragraph nobody wrote in", () => {
    let state = editorStateFrom([], "Only this.");
    state = addImage(state, "users/a/one.png");
    state = addTextSection(state);
    const stored = storedValue(state);

    expect(stored.blocks.filter((block) => block.type === "text")).toEqual([{ type: "text", text: "Only this." }]);
    expect(stored.text).toBe("Only this.");
  });
});

describe("the editing round trip", () => {
  it("survives write, illustrate, add a paragraph, type, save and reopen", () => {
    // Write.
    let state = editorStateFrom([], "");
    state = setBlockText(state, 0, "The tower has stood for nine hundred years.");
    expect(storedValue(state)).toEqual({ blocks: [], text: "The tower has stood for nine hundred years." });

    // Illustrate.
    state = addImage(state, "users/a/tower.png");
    expect(hasImages(state)).toBe(true);

    // Add a paragraph and write in it.
    state = addTextSection(state);
    state = setBlockText(state, state.length - 1, "Nobody remembers who built it.");

    // Save.
    const saved = storedValue(state);
    expect(saved.blocks.map((block) => block.type)).toEqual(["text", "image", "text"]);
    // The canonical text column carries the words and nothing about pictures:
    // this is what the roleplay model reads, and it must not know they exist.
    expect(saved.text).toBe("The tower has stood for nine hundred years.\n\nNobody remembers who built it.");
    expect(saved.text).not.toContain("tower.png");

    // Reopen.
    const reopened = editorStateFrom(saved.blocks, saved.text);
    expect(reopened).toEqual(saved.blocks);
    expect(storedValue(reopened)).toEqual(saved);
  });

  it("reorders and removes blocks without corrupting the pair", () => {
    let state = editorStateFrom([], "First.");
    state = addImage(state, "users/a/one.png");
    state = setBlockText(state, 2, "Second.");

    state = moveBlock(state, 0, 1);
    expect(state.map((block) => block.type)).toEqual(["image", "text", "text"]);
    // Moving past an edge is a no-op rather than a throw or a silent drop.
    expect(moveBlock(state, 0, -1)).toEqual(state);
    expect(moveBlock(state, state.length - 1, 1)).toEqual(state);

    state = setCaption(state, 0, "The tower at dusk");
    expect(storedValue(state).blocks[0]).toMatchObject({ type: "image", caption: "The tower at dusk" });

    // Removing the last image returns the field to a single plain textarea.
    state = collapseIfPlain(removeBlock(state, 0));
    expect(state).toHaveLength(1);
    expect(hasImages(state)).toBe(false);
    expect(storedValue(state)).toEqual({ blocks: [], text: "First.\n\nSecond." });
  });

  it("never leaves the creator with nothing to type into", () => {
    let state = editorStateFrom([], "Only paragraph.");
    state = removeBlock(state, 0);
    expect(state).toHaveLength(1);
    expect(state[0]).toEqual({ type: "text", text: "" });
  });
});

describe("every surface that shares the editor", () => {
  // World lore, a creation description and an opening message are the same
  // primitive with different starting content, so they are the same sequence.
  const surfaces = {
    "world lore": "The Verge is what the maps stopped at.",
    "creation description": "She writes your name in the margins of her poetry.",
    "opening message": `*She looks up as the door closes.* "You came."`,
  };

  for (const [surface, opening] of Object.entries(surfaces)) {
    it(`works for ${surface}`, () => {
      let state = editorStateFrom([], opening);
      state = addImage(state, "users/a/art.png");
      state = addTextSection(state);
      state = setBlockText(state, state.length - 1, "And then everything changed.");
      const saved = storedValue(state);

      expect(saved.text.startsWith(opening)).toBe(true);
      expect(saved.text.endsWith("And then everything changed.")).toBe(true);
      expect(editorStateFrom(saved.blocks, saved.text)).toEqual(saved.blocks);
    });
  }
});
