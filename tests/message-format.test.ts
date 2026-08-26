import { describe, expect, it } from "vitest";
import { compactMessagePreview, styleMessage, tokenizeCharacterMessage } from "@/lib/message-format";

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

  it("renders emphasis as emphasis instead of deleting its markers", () => {
    // The old renderer stripped every `**` it passed, which removed the stress
    // a writer meant along with the characters that carried it, and left every
    // `*action*` marker on screen because it never handled single markers at
    // all. Both are decided here now, and neither is decided by deletion.
    const styled = styleMessage('**She smiles.** "**Come closer.**" *Now.*');
    expect(styled.map((segment) => `${segment.kind}:${segment.bold ? "b" : ""}${segment.italic ? "i" : ""}:${segment.text}`)).toEqual([
      "narration:b:She smiles.",
      "narration::  ".trimEnd() + " ",
      "speech:b:Come closer.",
      "narration:: ",
      "narration:i:Now.",
    ]);
  });

  it("keeps a literal asterisk that was never emphasis", () => {
    expect(styleMessage("2 ** 8 is 256").map((segment) => segment.text).join("")).toBe("2 ** 8 is 256");
    expect(styleMessage("half *open").map((segment) => segment.text).join("")).toBe("half *open");
  });

  it("reads emphasis a provider escaped on its way out", () => {
    const styled = styleMessage('\\*\\*She stays still.\\*\\* "\\*\\*I remember.\\*\\*"');
    expect(styled.map((segment) => segment.text).join("")).toBe("She stays still. I remember.");
    expect(styled.every((segment) => segment.bold || !segment.text.trim())).toBe(true);
  });

  it("turns long conversation titles into a compact header preview", () => {
    expect(compactMessagePreview("  A very long message\nwith extra spacing that should not fill the entire header  ", 32))
      .toBe("A very long message with extra…");
  });
});
