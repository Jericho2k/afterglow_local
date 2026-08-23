import type { PoolClient } from "pg";
import { castMembersFromRow, characterFromRow } from "./db";
import type { Character } from "./types";

/**
 * Resource resolution for authenticated requests.
 *
 * Row level security already hides other accounts' rows, but every statement
 * here also carries an explicit `user_id` predicate. The two layers fail
 * independently: a policy mistake is caught by the predicate, and a forgotten
 * predicate is caught by the policy.
 */

/** The caller's conversation, or null when it is missing or somebody else's. */
export async function ownedConversation(client: PoolClient, userId: string, conversationId: string) {
  const result = await client.query("SELECT * FROM conversations WHERE id=$1 AND user_id=$2", [conversationId, userId]);
  return result.rows[0] ?? null;
}

/** A character the caller owns. Published characters belonging to others are excluded. */
export async function ownedCharacter(client: PoolClient, userId: string, characterId: string) {
  const result = await client.query("SELECT * FROM characters WHERE id=$1 AND user_id=$2", [characterId, userId]);
  return result.rows[0] ?? null;
}

/**
 * A character the caller may start a chat with: their own, or one its creator
 * published. Never one that is private to somebody else.
 */
export async function readableCharacter(client: PoolClient, userId: string, characterId: string) {
  const result = await client.query(
    "SELECT * FROM characters WHERE id=$1 AND (user_id=$2 OR visibility IN ('public','unlisted'))",
    [characterId, userId],
  );
  return result.rows[0] ?? null;
}

/** Personas are private with no publishing path, so only the owner's ids resolve. */
export async function ownedPersona(client: PoolClient, userId: string, personaId: string) {
  const result = await client.query("SELECT * FROM personas WHERE id=$1 AND user_id=$2", [personaId, userId]);
  return result.rows[0] ?? null;
}

/**
 * The fields a conversation freezes when it is started from somebody else's
 * character. Everything the roleplay prompt reads, and nothing else: the
 * import source material is deliberately excluded because it is never sent to
 * the model and would multiply the row size for no benefit.
 */
export const snapshotFields = [
  "name", "creationType", "title", "profileType", "tagline", "userRole", "avatarUrl", "avatarPath", "accent",
  "backstory", "cast", "lorebook", "personality", "scenario", "greeting", "alternateGreetings", "exampleDialogue",
  "responseDirective", "boundaries", "nsfwEnabled",
] as const;

export function characterSnapshot(character: Character) {
  const snapshot: Record<string, unknown> = {};
  for (const field of snapshotFields) snapshot[field] = character[field as keyof Character];
  return snapshot;
}

/**
 * Rebuilds a character from a conversation's frozen snapshot.
 *
 * A conversation with the caller's own character has no snapshot and reads the
 * live row, which keeps today's behaviour: editing your character updates your
 * existing chats. A conversation with somebody else's character replays the
 * definition it started with, so a creator editing or unpublishing cannot
 * rewrite the system prompt inside a stranger's ongoing story.
 */
export function characterFromSnapshot(snapshot: Record<string, unknown>, characterId: string): Character {
  const now = new Date(0).toISOString();
  return {
    id: characterId,
    name: String(snapshot.name || "Character"),
    // Snapshots taken before creations existed carry only the ensemble flag.
    creationType: snapshot.creationType === "cast" || snapshot.creationType === "scenario" || snapshot.creationType === "character"
      ? snapshot.creationType
      : snapshot.profileType === "ensemble" ? "cast" : "character",
    title: String(snapshot.title || ""),
    profileType: snapshot.profileType === "ensemble" ? "ensemble" : "single",
    tagline: String(snapshot.tagline || ""),
    // The public description is presentation, not part of a frozen roleplay
    // definition, so a snapshot never carries it.
    description: "",
    userRole: String(snapshot.userRole || ""),
    avatarUrl: String(snapshot.avatarUrl || ""),
    avatarPath: String(snapshot.avatarPath || ""),
    accent: String(snapshot.accent || "#e879a9"),
    backstory: String(snapshot.backstory || ""),
    cast: castMembersFromRow(snapshot.cast),
    lorebook: String(snapshot.lorebook || ""),
    personality: String(snapshot.personality || ""),
    scenario: String(snapshot.scenario || ""),
    greeting: String(snapshot.greeting || ""),
    alternateGreetings: Array.isArray(snapshot.alternateGreetings) ? snapshot.alternateGreetings.filter((item): item is string => typeof item === "string") : [],
    exampleDialogue: String(snapshot.exampleDialogue || ""),
    responseDirective: String(snapshot.responseDirective || ""),
    boundaries: String(snapshot.boundaries || ""),
    sourceMaterial: "",
    worldIds: [],
    // Public presentation data is not part of a frozen roleplay definition.
    tags: [],
    hashtags: [],
    quickFacts: [],
    gallery: [],
    publicStats: { messages: null, likes: null, chats: null, rank: null, rankCategory: null },
    visibility: "private",
    nsfwEnabled: Boolean(snapshot.nsfwEnabled),
    likeCount: 0,
    likedByViewer: false,
    creator: null,
    ownedByViewer: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The publicly shareable form of a creation.
 *
 * The public page shows what the creator wrote for readers; the instruction
 * fields that steer the model are the creator's working material and are not
 * part of what publishing shares. Fields the public page legitimately falls
 * back to for creations written before the description existed — backstory and
 * personality — are deliberately kept.
 */
export function visitorCharacter(character: Character): Character {
  return {
    ...character,
    responseDirective: "",
    boundaries: "",
    exampleDialogue: "",
    sourceMaterial: "",
    cast: character.cast.map((member) => ({ ...member, description: "" })),
  };
}

/**
 * The character definition a conversation should roleplay with, together with
 * whether the caller owns it. Foreign characters resolve from the snapshot.
 */
export async function conversationCharacter(client: PoolClient, userId: string, conversation: Record<string, unknown>) {
  const characterId = String(conversation.character_id);
  const snapshot = conversation.character_snapshot as Record<string, unknown> | null;
  if (snapshot && typeof snapshot === "object") {
    return { character: characterFromSnapshot(snapshot, characterId), owned: false };
  }
  const row = await ownedCharacter(client, userId, characterId);
  if (!row) return { character: null, owned: false };
  return { character: characterFromRow({ ...row, world_ids: [] }, userId), owned: true };
}
