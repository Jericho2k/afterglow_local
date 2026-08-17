import { describe, expect, it } from "vitest";
import { compactMessagePreview, tokenizeCharacterMessage } from "@/lib/message-format";

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

  it("hides double-asterisk formatting without removing single action markers", () => {
    const segments = tokenizeCharacterMessage('**She smiles.** "**Come closer.**" *Now.*');
    expect(segments).toEqual([
      { text: "She smiles. ", kind: "narration" },
      { text: "Come closer.", kind: "speech" },
      { text: " *Now.*", kind: "narration" },
    ]);
  });

  it("turns long conversation titles into a compact header preview", () => {
    expect(compactMessagePreview("  A very long message\nwith extra spacing that should not fill the entire header  ", 32))
      .toBe("A very long message with extra…");
  });
});
