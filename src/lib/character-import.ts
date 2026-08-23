import { characterSchema } from "./schemas";
import { parseLenientJson } from "./json-repair";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number) {
  if (value == null) return "";
  const result = typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join("\n") : String(value);
  return result.trim().slice(0, limit);
}

function list(value: unknown, itemLimit: number, countLimit: number) {
  if (Array.isArray(value)) return value.map((item) => text(item, itemLimit)).filter(Boolean).slice(0, countLimit);
  const single = text(value, itemLimit);
  return single ? [single] : [];
}

function parseObject(raw: string) {
  // Large imports are exactly where models produce a missing comma, a raw
  // newline inside prose, or a response that stops mid-array. Recovering the
  // document beats discarding a long paste over a formatting slip.
  return object(parseLenientJson<unknown>(raw));
}

/**
 * Provider output is never trusted as an application payload. This adapter
 * accepts common card-field aliases, repairs harmless formatting mistakes,
 * bounds every value, and then lets the canonical Zod schema decide.
 */
export function normalizeGeneratedCharacter(raw: string, sourceMaterial: string, nsfwEnabled: boolean) {
  const value = parseObject(raw);
  const rawCast = value.cast ?? value.characters ?? value.castMembers ?? [];
  const cast = (Array.isArray(rawCast) ? rawCast : []).map((entry) => {
    const item = object(entry);
    return {
      name: text(item.name ?? item.characterName, 120),
      role: text(item.role ?? item.relationship, 240),
      description: text(item.description ?? item.profile ?? item.details ?? item.personality, 8000),
      tagline: text(item.tagline ?? item.summary ?? item.shortDescription, 240),
      avatarPath: "",
      avatarUrl: "",
    };
  }).filter((entry) => entry.name).slice(0, 50);

  const named = text(value.name ?? value.characterName ?? value.cardName, 120);
  const titled = text(value.title ?? value.cardName, 120);
  const typeHint = text(value.creationType ?? value.profileType ?? value.cardType ?? value.type, 40).toLowerCase();
  // Scenario is only chosen when the model says so. Falling back to "cast" for
  // ensemble material keeps every earlier import mapping exactly as it did.
  const creationType = typeHint.includes("scenario") || typeHint.includes("rpg")
    ? "scenario" as const
    : typeHint.includes("ensemble") || typeHint.includes("cast") || typeHint.includes("multiple") || cast.length > 1
      ? "cast" as const
      : "character" as const;
  const profileType = creationType === "character" ? "single" : "ensemble";
  const name = named || titled || (profileType === "ensemble" && cast.length ? cast.slice(0, 4).map((item) => item.name).join(" · ").slice(0, 120) : cast[0]?.name) || "Imported character";
  const title = titled || (creationType === "character" ? "" : name);
  const rawAccent = text(value.accent ?? value.color, 20);
  const accent = /^#[0-9a-f]{6}$/i.test(rawAccent) || /^#[0-9a-f]{3}$/i.test(rawAccent) ? rawAccent : "#e879a9";
  const rawAvatar = text(value.avatarUrl ?? value.avatar ?? value.imageUrl ?? value.image, 1500);
  const avatarUrl = /^https?:\/\//i.test(rawAvatar) ? rawAvatar : "";

  return characterSchema.parse({
    name,
    title,
    creationType,
    profileType,
    tagline: text(value.tagline ?? value.hook ?? value.summary, 300),
    description: text(value.description ?? value.publicDescription ?? value.premise, 6000),
    userRole: text(value.userRole ?? value.playerRole ?? value.yourRole, 4000),
    avatarUrl,
    avatarPath: "",
    accent,
    backstory: text(value.backstory ?? value.bio ?? value.description ?? value.history, 30000),
    cast,
    lorebook: text(value.lorebook ?? value.world ?? value.worldInfo ?? value.worldCanon, 50000),
    personality: text(value.personality ?? value.persona ?? value.mannerisms, 12000),
    scenario: text(value.scenario ?? value.openingScenario ?? value.setting, 12000),
    greeting: text(value.greeting ?? value.firstMessage ?? value.initialMessage, 8000),
    alternateGreetings: list(value.alternateGreetings ?? value.alternativeGreetings ?? value.initialMessages, 8000, 12),
    exampleDialogue: text(value.exampleDialogue ?? value.dialogueExamples ?? value.exampleMessages, 12000),
    responseDirective: text(value.responseDirective ?? value.systemPrompt ?? value.instructions, 8000),
    boundaries: text(value.boundaries ?? value.limits ?? value.contentRules, 5000),
    sourceMaterial,
    worldIds: [],
    visibility: "private",
    nsfwEnabled,
  });
}
