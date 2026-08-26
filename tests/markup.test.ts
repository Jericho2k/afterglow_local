import { describe, expect, it } from "vitest";
import { parseInlineMarkup, plainText } from "@/lib/markup";

/**
 * Emphasis renders; a literal asterisk survives.
 *
 * The old renderer deleted every `**` it found, which is the one thing the
 * brief explicitly rules out. These cases are the line between the two: markup
 * is markup only when it pairs, and everything else is the reader's or the
 * writer's own characters.
 */

const marks = (text: string) => parseInlineMarkup(text).map((segment) =>
  `${segment.bold ? "b" : ""}${segment.italic ? "i" : ""}${segment.bold || segment.italic ? ":" : ""}${segment.text}`);

describe("emphasis", () => {
  it("renders bold and drops only its markers", () => {
    expect(marks("say **that** again")).toEqual(["say ", "b:that", " again"]);
  });

  it("renders the italics the system prompt asks the writer for", () => {
    // "Use *italics* for actions and narration" is an instruction in the
    // roleplay prompt, and the renderer used to show the asterisks around every
    // single gesture in the product.
    expect(marks("*She looks up.* \"Hello.\"")).toEqual(["i:She looks up.", " \"Hello.\""]);
  });

  it("understands underscores between words", () => {
    expect(marks("_quietly_ then")).toEqual(["i:quietly", " then"]);
  });

  it("nests bold inside italics and the other way round", () => {
    expect(marks("*a **b** c*")).toEqual(["i:a ", "bi:b", "i: c"]);
    expect(marks("***both***")).toEqual(["bi:both"]);
  });
});

describe("literal asterisks are preserved", () => {
  it("keeps an unmatched marker exactly as written", () => {
    // The old renderer deleted this, so a malformed reply lost characters.
    expect(plainText("what ** is this")).toBe("what ** is this");
    expect(plainText("half *open")).toBe("half *open");
  });

  it("keeps arithmetic", () => {
    expect(plainText("2 ** 8 is 256")).toBe("2 ** 8 is 256");
    expect(marks("2 ** 8")).toEqual(["2 ** 8"]);
  });

  it("does not read a pair around whitespace as emphasis", () => {
    expect(plainText("* item one * item two")).toBe("* item one * item two");
  });

  it("leaves snake_case identifiers alone", () => {
    expect(plainText("open source_material_field now")).toBe("open source_material_field now");
  });

  it("honours a backslash escape when the escapes are the reader's own", () => {
    // A person who types `\*` means an asterisk. `providerEscapes: false` is
    // what the reader's own messages are rendered with.
    expect(plainText("a \\*not italic\\* b", { providerEscapes: false })).toBe("a *not italic* b");
    expect(plainText("\\*\\*shouty\\*\\*", { providerEscapes: false })).toBe("**shouty**");
  });

  it("keeps an empty pair literal rather than swallowing it", () => {
    expect(plainText("****")).toBe("****");
  });
});

describe("malformed input", () => {
  it("never loses characters it did not turn into markup", () => {
    for (const sample of ["***", "**a*", "*a**", "a*b*c*d", "**", "*", "_ _", "__x", "*a\nb*"]) {
      const rendered = plainText(sample);
      // Everything either became emphasis (markers consumed in pairs) or stayed
      // exactly as typed. Nothing may simply disappear.
      const strippedPairs = sample.replace(/\*\*/g, "").replace(/\*/g, "").replace(/_/g, "");
      expect(rendered.replace(/[*_]/g, "")).toBe(strippedPairs);
    }
  });

  it("terminates on adversarial nesting", () => {
    const deep = `${"*".repeat(40)}word${"*".repeat(40)}`;
    expect(() => parseInlineMarkup(deep)).not.toThrow();
    expect(plainText(deep)).toContain("word");
  });
});

describe("plain text", () => {
  it("resolves markup away for previews and titles", () => {
    expect(plainText("**A quiet** *evening*")).toBe("A quiet evening");
  });
});

describe("emphasis a provider escaped on its way out", () => {
  it("reads a matched escaped pair as the emphasis it meant", () => {
    // Some routed models emit their own markdown already escaped. Read
    // strictly that is two literal asterisks; read honestly it is bold, and
    // nobody typing literal asterisks in a chat box types backslashes first.
    expect(marks("\\*\\*She stays still.\\*\\*")).toEqual(["b:She stays still."]);
    expect(plainText('\\*\\*She stays still.\\*\\* "\\*\\*I remember.\\*\\*"'))
      .toBe('She stays still. "I remember."');
  });

  it("still treats a lone escape as the literal character it protects", () => {
    expect(plainText("a \\* b")).toBe("a * b");
    expect(plainText("rating: 5\\*")).toBe("rating: 5*");
  });
});
