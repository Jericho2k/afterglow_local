import { describe, expect, it } from "vitest";
import { tokenizeCharacterMessage } from "@/lib/message-format";

describe("character message formatting", () => {
  it("separates straight-quoted speech and removes display markers", () => {
    const segments = tokenizeCharacterMessage('*She smiles.* "I missed you." *She steps closer.*');
    expect(segments).toEqual([
      { text: "*She smiles.* ", kind: "narration" },
      { text: "I missed you.", kind: "speech" },
      { text: " *She steps closer.*", kind: "narration" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).not.toContain('"');
  });

  it("supports curly quotes and multiple dialogue sections", () => {
    const segments = tokenizeCharacterMessage('“First.” She pauses. “Second.”');
    expect(segments.filter((segment) => segment.kind === "speech").map((segment) => segment.text)).toEqual(["First.", "Second."]);
  });

  it("treats an unfinished quote as streaming speech", () => {
    expect(tokenizeCharacterMessage('*She begins.* "Still typing')).toEqual([
      { text: "*She begins.* ", kind: "narration" },
      { text: "Still typing", kind: "speech" },
    ]);
  });
});
