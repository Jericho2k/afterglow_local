import { describe, expect, it, vi } from "vitest";
import { bookToWorldLore, parseCard, parseCardObject, pngTextChunks, suggestedContentMode } from "@/lib/character-card";
import { importedCreation } from "@/lib/card-import";
import { adultCard, pngCard, v1Card, v2Card, v3Card } from "./fixtures/character-cards";

/**
 * Importing a character card.
 *
 * The promise this feature makes is narrow and absolute: what the creator wrote
 * elsewhere arrives here unchanged. Most of these assertions are therefore
 * about words being IDENTICAL rather than about a field being non-empty — a
 * test that only checks "the description imported" would pass against an
 * importer that had quietly summarised it.
 */

const alice = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: alice, email: null };
vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
const importRoute = await import("@/app/api/characters/import-card/route");

function post(body: Uint8Array | string) {
  // `BodyInit` wants a buffer view's own buffer, not the view.
  const payload = typeof body === "string" ? body : new Uint8Array(body).buffer as ArrayBuffer;
  return new Request("http://test/api/characters/import-card", { method: "POST", body: payload });
}

describe("reading the three card specs", () => {
  it("reads a V1 card, which has no wrapper at all", () => {
    const card = parseCardObject(v1Card)!;
    expect(card.spec).toBe("v1");
    expect(card.name).toBe("Wren Calloway");
    expect(card.firstMessage).toBe(v1Card.first_mes);
    expect(card.exampleDialogue).toBe(v1Card.mes_example);
  });

  it("reads a V2 card out of its data envelope", () => {
    const card = parseCardObject(v2Card)!;
    expect(card.spec).toBe("v2");
    expect(card.systemPrompt).toBe("Write in close third person. Never narrate {{user}}'s thoughts.");
    expect(card.alternateGreetings).toHaveLength(1);
    expect(card.book?.entries).toHaveLength(3);
  });

  it("reads V3 additions without losing anything V2 had", () => {
    const card = parseCardObject(v3Card)!;
    expect(card.spec).toBe("v3");
    expect(card.nickname).toBe("The Keeper");
    expect(card.groupOnlyGreetings).toEqual(["\"Both of you? The path barely takes one.\""]);
    expect(card.systemPrompt).toBe(v2Card.data.system_prompt);
  });

  it("refuses a JSON file that is not a character card", () => {
    expect(parseCardObject({ hello: "world" })).toBeNull();
    expect(parseCardObject(null)).toBeNull();
  });
});

describe("PNG cards", () => {
  it("finds the card in a tEXt chunk of a real PNG", () => {
    const bytes = pngCard([{ keyword: "chara", json: v2Card }]);
    // The fixture is a valid PNG, not a shape the parser happens to accept.
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const card = parseCard(bytes)!;
    expect(card.name).toBe("Wren Calloway");
    expect(card.spec).toBe("v2");
  });

  /*
   * The rule from the V3 spec, and the one most likely to be got wrong: an
   * exporter writes BOTH chunks so the file opens in old clients too, and the
   * `chara` copy is a backfill that may be stale. A reader seeing both must
   * use `ccv3`.
   */
  it("prefers ccv3 when a card carries both chunks", () => {
    const bytes = pngCard([
      { keyword: "chara", json: { ...v2Card, data: { ...v2Card.data, name: "Stale V2 Backfill" } } },
      { keyword: "ccv3", json: v3Card },
    ]);
    const card = parseCard(bytes)!;
    expect(card.spec).toBe("v3");
    expect(card.name).toBe("Wren Calloway");
  });

  it("reads chunks without decoding the image", () => {
    const bytes = pngCard([{ keyword: "chara", json: v1Card }]);
    const chunks = pngTextChunks(bytes);
    expect(chunks.has("chara")).toBe(true);
    // IHDR and IDAT are present and untouched: nothing here re-encodes a file.
    expect(chunks.has("IDAT")).toBe(false);
  });

  it("survives a truncated file rather than throwing", () => {
    const bytes = pngCard([{ keyword: "chara", json: v1Card }]).slice(0, 30);
    expect(() => parseCard(bytes)).not.toThrow();
  });
});

describe("mapping a card into a creation", () => {
  it("preserves every authored field word for word", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    // The card's `description` is the model-facing definition, so it lands in
    // backstory — never on the public description, which is page copy.
    expect(imported.backstory).toBe(v2Card.data.description);
    expect(imported.personality).toBe(v2Card.data.personality);
    expect(imported.scenario).toBe(v2Card.data.scenario);
    expect(imported.greeting).toBe(v2Card.data.first_mes);
    expect(imported.exampleDialogue).toBe(v2Card.data.mes_example);
    expect(imported.alternateGreetings).toContain(v2Card.data.alternate_greetings[0]);
  });

  it("keeps two instruction fields distinguishable instead of blending them", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    expect(imported.responseDirective).toContain(v2Card.data.system_prompt);
    expect(imported.responseDirective).toContain(v2Card.data.post_history_instructions);
    expect(imported.responseDirective).toContain("post-history instructions");
  });

  it("never publishes creator notes", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    const notes = v2Card.data.creator_notes;
    // Owner-only source material is the only place they appear.
    expect(imported.sourceMaterial).toContain(notes);
    expect(imported.backstory).not.toContain(notes);
    expect(imported.tagline).not.toContain(notes);
    expect(imported.scenario).not.toContain(notes);
    expect(imported.personality).not.toContain(notes);
  });

  it("invents no tagline", () => {
    // A tagline is public marketing copy; no card field means the same thing,
    // and deriving one from the description would be a silent rewrite.
    expect(importedCreation(parseCardObject(v2Card)!).tagline).toBe("");
  });

  it("splits tags into the taxonomy and the creator's own vocabulary", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    expect(imported.tags).toContain("Romance");
    expect(imported.hashtags).toContain("myowncategory");
  });

  it("keeps a nickname as the title and the real name as the name", () => {
    const imported = importedCreation(parseCardObject(v3Card)!);
    expect(imported.name).toBe("Wren Calloway");
    expect(imported.title).toBe("The Keeper");
  });

  it("keeps group-only greetings rather than dropping them", () => {
    const imported = importedCreation(parseCardObject(v3Card)!);
    expect(imported.alternateGreetings).toContain(v3Card.data.group_only_greetings[0]);
  });
});

describe("lorebooks become worlds", () => {
  it("maps entries to world lore with their keywords intact", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    expect(imported.lorebook).toContain("The Mairi went down in 1981");
    expect(imported.lorebook).toContain("Keywords: the wreck, Mairi");
    expect(imported.proposedWorld?.name).toBe("The Calloway Coast");
  });

  it("does not stuff lore into a character field", () => {
    const imported = importedCreation(parseCardObject(v2Card)!);
    expect(imported.backstory).not.toContain("The Mairi went down");
    expect(imported.personality).not.toContain("The Mairi went down");
  });

  it("honours a disabled entry", () => {
    const lore = bookToWorldLore(parseCardObject(v2Card)!.book!);
    expect(lore).not.toContain("Cut from an earlier draft");
  });

  it("treats a missing enabled flag as enabled", () => {
    // Every format writes the flag as an opt-out, so reading absence as "off"
    // would silently drop the lorebook of any card that never wrote it.
    const card = parseCardObject({
      ...v2Card,
      data: { ...v2Card.data, character_book: { entries: [{ keys: ["k"], content: "Kept." }] } },
    })!;
    expect(bookToWorldLore(card.book!)).toContain("Kept.");
  });
});

describe("an imported card is reviewed, not published", () => {
  it("suggests the restrictive mode for a card its author tagged explicit", () => {
    expect(suggestedContentMode(parseCardObject(adultCard)!)).toBe("adult_focused");
  });

  it("suggests the middle mode for romance without explicit tags", () => {
    expect(suggestedContentMode(parseCardObject(v2Card)!)).toBe("adult_capable");
  });

  it("suggests clean when the card claims nothing", () => {
    expect(suggestedContentMode(parseCardObject(v1Card)!)).toBe("clean");
  });

  it("returns a draft and creates nothing", async () => {
    const response = await importRoute.POST(post(pngCard([{ keyword: "chara", json: adultCard }])));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.creation.name).toBe("Vesper Lang");
    expect(body.suggestedContentMode).toBe("adult_focused");
    // No id, because nothing was written. Publishing is the creator's act.
    expect(body.creation.id).toBeUndefined();
    expect(body.creation).not.toHaveProperty("visibility");
  });

  it("refuses a file with no card in it", async () => {
    const response = await importRoute.POST(post("just some text"));
    expect(response.status).toBe(422);
  });

  it("refuses an anonymous caller", async () => {
    account = null;
    const response = await importRoute.POST(post(pngCard([{ keyword: "chara", json: v1Card }])));
    expect(response.status).toBe(401);
    account = { id: alice, email: null };
  });
});
