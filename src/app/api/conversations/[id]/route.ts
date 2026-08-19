import { ownedConversation, ownedPersona } from "@/lib/access";
import { asUser, conversationFromRow } from "@/lib/db";
import { conversationUpdateSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = conversationUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid conversation change" }, { status: 400 });
  const value = parsed.data;

  const row = await asUser(account.id, async (client) => {
    const current = await ownedConversation(client, account.id, id);
    if (!current) return null;

    // A persona from another account must never become the voice the user
    // speaks with, so an unknown id clears the field instead of being stored.
    let personaId = current.persona_id;
    if (value.personaId !== undefined) {
      personaId = value.personaId ? (await ownedPersona(client, account.id, value.personaId))?.id ?? null : null;
    }

    const result = await client.query(
      "UPDATE conversations SET title=$1,persona_id=$2,instruction_presets=$3,custom_instructions=$4,updated_at=now() WHERE id=$5 AND user_id=$6 RETURNING *",
      [value.title ?? current.title, personaId, value.instructionPresets ?? current.instruction_presets, value.customInstructions ?? current.custom_instructions, id, account.id],
    );
    return result.rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ conversation: conversationFromRow(row) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const result = await asUser(account.id, (client) =>
    client.query("DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING character_id", [id, account.id]));
  if (!result.rowCount) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ ok: true, characterId: result.rows[0].character_id });
}
