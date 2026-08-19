import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { conversationFromRow, messageFromRow, query } from "@/lib/db";

async function createConversation(characterId: string, greetingIndex = 0) {
  const id = randomUUID();
  const character = await query("SELECT name,greeting,alternate_greetings FROM characters WHERE id=$1", [characterId]);
  if (!character.rowCount) return null;
  let result = await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,$3) RETURNING *", [id, characterId, `Chat with ${character.rows[0].name}`]);
  const alternatives = Array.isArray(character.rows[0].alternate_greetings) ? character.rows[0].alternate_greetings.filter((item): item is string => typeof item === "string") : [];
  const greetings = [String(character.rows[0].greeting || ""), ...alternatives];
  const safeIndex = Number.isInteger(greetingIndex) && greetingIndex >= 0 && greetingIndex < greetings.length ? greetingIndex : 0;
  const greeting = String(greetings[safeIndex] || "").trim();
  if (greeting) {
    await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant',$3)", [randomUUID(), id, greeting]);
    result = await query("UPDATE conversations SET message_count=1 WHERE id=$1 RETURNING *", [id]);
  }
  return conversationFromRow(result.rows[0]);
}

export async function GET(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const url = new URL(request.url);
  const characterId = url.searchParams.get("characterId");
  const requestedId = url.searchParams.get("conversationId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });
  let listResult = await query("SELECT * FROM conversations WHERE character_id=$1 ORDER BY updated_at DESC, created_at DESC", [characterId]);
  if (!listResult.rowCount) {
    const created = await createConversation(characterId);
    if (!created) return Response.json({ error: "Character not found" }, { status: 404 });
    listResult = await query("SELECT * FROM conversations WHERE character_id=$1 ORDER BY updated_at DESC, created_at DESC", [characterId]);
  }
  const conversations = listResult.rows.map(conversationFromRow);
  const conversation = requestedId ? conversations.find((item) => item.id === requestedId) : conversations[0];
  if (!conversation) return Response.json({ error: "Conversation not found" }, { status: 404 });
  const messages = await query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC, id ASC", [conversation.id]);
  return Response.json({ conversations, conversation, messages: messages.rows.map(messageFromRow) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (typeof body.characterId !== "string") return Response.json({ error: "characterId is required" }, { status: 400 });
  const greetingIndex = typeof body.greetingIndex === "number" ? body.greetingIndex : 0;
  const conversation = await createConversation(body.characterId, greetingIndex);
  if (!conversation) return Response.json({ error: "Character not found" }, { status: 404 });
  const messages = await query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC, id ASC", [conversation.id]);
  return Response.json({ conversation, messages: messages.rows.map(messageFromRow) }, { status: 201 });
}
