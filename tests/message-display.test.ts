import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { displaySegments, styleMessage } from "@/lib/message-format";
import { parseInlineMarkup } from "@/lib/markup";

/**
 * What a reply LOOKS like, as opposed to what it says.
 *
 * The previous sprint stopped raw `**` reaching the screen by parsing markup
 * instead of deleting it. That was right, and it produced the complaint this
 * suite is about: `*action*` is the roleplay convention for narration, it is
 * most of the prose in a story, and rendering it as emphasis put most of every
 * reply in italics.
 *
 * The fix is a rendering rule, not a parsing one, and this file holds both
 * halves of that distinction: the parser still reports what the writer wrote,
 * and `displaySegments` decides that single-marker emphasis is drawn in the
 * ordinary face. Everything else — bold, literal asterisks, unmatched markers,
 * paragraph structure — is asserted here too, because those are exactly what a
 * naive "strip the asterisks" fix would break on the way past.
 */

/** Everything a reader would actually see, markers resolved. */
function visible(content: string) {
  return displaySegments(content).map((segment) => segment.text).join("");
}
function italicised(content: string) {
  return displaySegments(content).filter((segment) => segment.italic).map((segment) => segment.text);
}
function bolded(content: string) {
  return displaySegments(content).filter((segment) => segment.bold).map((segment) => segment.text);
}

describe("narration is not italic", () => {
  it("renders an action without its markers and without italics", () => {
    const content = "*She sets the glass down.* \"You're late.\"";
    expect(visible(content)).toBe("She sets the glass down. You're late.");
    expect(italicised(content)).toEqual([]);
  });

  it("still reports the markup faithfully at the parsing layer", () => {
    // The rendering decision must not become a parsing decision: something
    // that needs to know what the writer wrote still can.
    expect(parseInlineMarkup("*She smiles.*")).toEqual([{ text: "She smiles.", bold: false, italic: true }]);
    expect(styleMessage("*She smiles.*").every((segment) => segment.italic)).toBe(true);
  });

  it("leaves a whole reply of narration in one face", () => {
    const reply = "*He crosses the room.* \"Sit down.\" *The chair scrapes.*";
    expect(italicised(reply)).toEqual([]);
    expect(visible(reply)).toBe("He crosses the room. Sit down. The chair scrapes.");
  });

  it("treats underscores the same way, since the convention is the same", () => {
    expect(italicised("_she whispers_")).toEqual([]);
    expect(visible("_she whispers_")).toBe("she whispers");
  });
});

describe("emphasis that meant emphasis survives", () => {
  it("keeps bold bold", () => {
    expect(bolded("She said **no**.")).toEqual(["no"]);
    expect(visible("She said **no**.")).toBe("She said no.");
  });

  it("renders bold-and-italic as bold, because the italic half is narration", () => {
    const segments = displaySegments("***absolutely not***");
    expect(segments).toEqual([{ text: "absolutely not", bold: true, italic: false, kind: "narration" }]);
  });

  it("keeps bold inside speech", () => {
    expect(bolded("\"I said **no**.\"")).toEqual(["no"]);
  });
});

describe("literal asterisks stay literal", () => {
  it("preserves an exponent", () => {
    expect(visible("2 ** 8 is 256")).toBe("2 ** 8 is 256");
  });

  it("preserves an unmatched opener", () => {
    expect(visible("she trailed off *")).toBe("she trailed off *");
    expect(visible("*unclosed narration")).toBe("*unclosed narration");
  });

  it("preserves an escaped asterisk", () => {
    expect(visible("a literal \\* here")).toBe("a literal * here");
  });

  it("does not eat an identifier's underscores", () => {
    expect(visible("the file is some_file_name.txt")).toBe("the file is some_file_name.txt");
  });
});

describe("structure is untouched", () => {
  it("keeps paragraph breaks", () => {
    const content = "*She turns away.*\n\n\"Don't follow me.\"";
    expect(visible(content)).toContain("\n\n");
  });

  it("keeps the speech/narration split the chat colours by", () => {
    const kinds = displaySegments("*She stands.* \"Go.\"").map((segment) => segment.kind);
    expect(kinds).toContain("narration");
    expect(kinds).toContain("speech");
  });

  it("resolves a provider's escaped bold, and only when it pairs", () => {
    expect(visible("\\*\\*emphatic\\*\\*")).toBe("emphatic");
    expect(bolded("\\*\\*emphatic\\*\\*")).toEqual(["emphatic"]);
    // A lone escape is a person's deliberate instruction, not a provider's.
    expect(visible("one \\* only")).toBe("one * only");
  });
});

describe("the chat renders through the display rule", () => {
  const styledText = readFileSync(new URL("../src/components/rich/StyledText.tsx", import.meta.url), "utf8");

  it("uses displaySegments for messages rather than the raw parse", () => {
    expect(styledText).toContain("displaySegments(content");
    expect(styledText).not.toContain("styleMessage(content");
  });
});

describe("the writer is no longer asked to produce italics", () => {
  const prompts = readFileSync(new URL("../src/lib/prompts.ts", import.meta.url), "utf8");

  it("does not ask for *italics* around actions", () => {
    // Asking for markup the UI deliberately renders as ordinary prose is
    // tokens spent on every line of every reply to produce nothing visible.
    expect(prompts).not.toContain("Use *italics* for actions");
  });

  it("says what to do instead", () => {
    expect(prompts).toContain("Write actions and narration as ordinary prose");
    expect(prompts).toContain("Do NOT wrap narration or actions in asterisks");
  });

  it("still permits bold for genuine emphasis", () => {
    expect(prompts).toContain("Reserve **bold** for genuine emphasis");
  });
});
