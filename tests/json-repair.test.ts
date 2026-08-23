import { describe, expect, it } from "vitest";
import { parseLenientJson } from "@/lib/json-repair";

/**
 * Every malformed case here is a shape models actually emit on large character
 * imports. The reported failure was
 * "Expected ',' or ']' after array element in JSON at position 7441", which is
 * the missing-comma case below.
 */
describe("provider JSON recovery", () => {
  it("leaves well-formed documents untouched", () => {
    const value = { name: "Mira", cast: [{ name: "Idris" }], nsfwEnabled: true, count: 3 };
    expect(parseLenientJson(JSON.stringify(value))).toEqual(value);
  });

  it("keeps prose containing braces and brackets intact", () => {
    const value = { backstory: 'She wrote "{not json}" and [brackets] in her diary.' };
    expect(parseLenientJson(JSON.stringify(value))).toEqual(value);
  });

  it("strips markdown fences and surrounding prose", () => {
    const raw = 'Here is the card:\n```json\n{"name":"Mira"}\n```\nHope that helps!';
    expect(parseLenientJson<{ name: string }>(raw).name).toBe("Mira");
  });

  it("recovers a missing comma between array elements", () => {
    const raw = '{"alternateGreetings":["First opening."\n"Second opening."\n"Third opening."]}';
    expect(parseLenientJson<{ alternateGreetings: string[] }>(raw).alternateGreetings)
      .toEqual(["First opening.", "Second opening.", "Third opening."]);
  });

  it("recovers a missing comma between objects and after keys", () => {
    const raw = '{"cast":[{"name":"Mira"}{"name":"Idris"}],"name":"Ensemble"}';
    const parsed = parseLenientJson<{ cast: { name: string }[]; name: string }>(raw);
    expect(parsed.cast.map((entry) => entry.name)).toEqual(["Mira", "Idris"]);
    expect(parsed.name).toBe("Ensemble");
  });

  it("escapes raw newlines inside multi-paragraph prose fields", () => {
    const raw = '{"backstory":"First paragraph.\nSecond paragraph.\tTabbed."}';
    expect(parseLenientJson<{ backstory: string }>(raw).backstory)
      .toBe("First paragraph.\nSecond paragraph.\tTabbed.");
  });

  it("drops trailing commas before closing brackets", () => {
    const raw = '{"cast":[{"name":"Mira"},],"tags":["a","b",],}';
    const parsed = parseLenientJson<{ cast: { name: string }[]; tags: string[] }>(raw);
    expect(parsed.cast).toHaveLength(1);
    expect(parsed.tags).toEqual(["a", "b"]);
  });

  it("closes a response that stopped mid-array", () => {
    const raw = '{"name":"Mira","alternateGreetings":["Kept opening.","Half writ';
    const parsed = parseLenientJson<{ name: string; alternateGreetings: string[] }>(raw);
    expect(parsed.name).toBe("Mira");
    expect(parsed.alternateGreetings).toEqual(["Kept opening."]);
  });

  it("closes a response that stopped mid-object", () => {
    const raw = '{"name":"Mira","cast":[{"name":"Idris","role":"rival"},{"name":"Half';
    const parsed = parseLenientJson<{ name: string; cast: { name: string }[] }>(raw);
    expect(parsed.name).toBe("Mira");
    expect(parsed.cast[0].name).toBe("Idris");
  });

  it("preserves escaped quotes rather than treating them as string ends", () => {
    const value = { greeting: 'She said \\"hello\\" softly.' };
    const parsed = parseLenientJson<{ greeting: string }>(JSON.stringify(value));
    expect(parsed.greeting).toBe(value.greeting);
  });

  it("reports a clear error when nothing can be recovered", () => {
    expect(() => parseLenientJson("not json at all")).toThrow(/malformed JSON/i);
  });
});
