import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { characterSnapshot, ownedPersona, readableCharacter } from "@/lib/access";
import { asUser, characterFromRow, conversationFromRow, getUserSettings, messageFromRow } from "@/lib/db";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Starts a chat.
 *
 * The character must be one the caller owns or one its creator published;
 * anything else resolves to null and the request fails before a row is
 * written. When the character belongs to somebody else the conversation keeps
 * a frozen copy of the definition, so the creator editing or unpublishing it
 * later cannot rewrite the system prompt inside this story.
 */
async function createConversation(client: PoolClient, userId: string, characterId: string, greetingIndex = 0, personaId?: string | null) {
  const characterRow = await readableCharacter(client, userId, characterId);
  if (!characterRow) return null;
  const owned = String(characterRow.user_id ?? "") === userId;
  const character = characterFromRow({ ...characterRow, world_ids: [] }, userId);

  let resolvedPersonaId: string | null = null;
  if (personaId) {
    const persona = await ownedPersona(client, userId, personaId);
    resolvedPersonaId = persona ? String(persona.id) : null;
  }
  if (!resolvedPersonaId) {
    const defaultPersona = await client.query("SELECT id FROM personas WHERE user_id=$1 AND is_default=true LIMIT 1", [userId]);
    resolvedPersonaId = defaultPersona.rowCount ? String(defaultPersona.rows[0].id) : null;
  }

  const id = randomUUID();
  const settings = await getUserSettings(client, userId);
  let result = await client.query(
    "INSERT INTO conversations (id,character_id,user_id,title,persona_id,character_snapshot,provider_id,model_id,rp_engine_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *",
    [id, characterId, userId, `Chat with ${character.name}`, resolvedPersonaId, owned ? null : JSON.stringify(characterSnapshot(character)),settings.providerId,settings.model,settings.roleplayPreset],
  );

  const greetings = [character.greeting, ...character.alternateGreetings];
  const safeIndex = Number.isInteger(greetingIndex) && greetingIndex >= 0 && greetingIndex < greetings.length ? greetingIndex : 0;
  const greeting = String(greetings[safeIndex] || "").trim();
  if (greeting) {
    await client.query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant',$4)", [randomUUID(), id, userId, greeting]);
    result = await client.query("UPDATE conversations SET message_count=1 WHERE id=$1 AND user_id=$2 RETURNING *", [id, userId]);
  }
  return conversationFromRow(result.rows[0]);
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const url = new URL(request.url);
  const characterId = url.searchParams.get("characterId");
  const requestedId = url.searchParams.get("conversationId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });

  const payload = await asUser(account.id, async (client) => {
    let listResult = await client.query(
      "SELECT * FROM conversations WHERE character_id=$1 AND user_id=$2 ORDER BY updated_at DESC, created_at DESC",
      [characterId, account.id],
    );
    if (!listResult.rowCount) {
      const created = await createConversation(client, account.id, characterId);
      if (!created) return { error: "Character not found", status: 404 as const };
      listResult = await client.query(
        "SELECT * FROM conversations WHERE character_id=$1 AND user_id=$2 ORDER BY updated_at DESC, created_at DESC",
        [characterId, account.id],
      );
    }
    const conversations = listResult.rows.map(conversationFromRow);
    const conversation = requestedId ? conversations.find((item) => item.id === requestedId) : conversations[0];
    if (!conversation) return { error: "Conversation not found", status: 404 as const };
    const messages = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC, id ASC",
      [conversation.id, account.id],
    );
    return { conversations, conversation, messages: messages.rows.map(messageFromRow) };
  });

  if ("error" in payload) return Response.json({ error: payload.error }, { status: payload.status });
  return Response.json(payload);
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const body = await request.json().catch(() => ({}));
  if (typeof body.characterId !== "string") return Response.json({ error: "characterId is required" }, { status: 400 });
  const greetingIndex = typeof body.greetingIndex === "number" ? body.greetingIndex : 0;
  const personaId = typeof body.personaId === "string" ? body.personaId : null;

  const payload = await asUser(account.id, async (client) => {
    const conversation = await createConversation(client, account.id, body.characterId, greetingIndex, personaId);
    if (!conversation) return null;
    const messages = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC, id ASC",
      [conversation.id, account.id],
    );
    return { conversation, messages: messages.rows.map(messageFromRow) };
  });

  if (!payload) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json(payload, { status: 201 });
}
