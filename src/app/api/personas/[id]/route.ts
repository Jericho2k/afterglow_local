import { asUser, personaFromRow } from "@/lib/db";
import { personaSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = personaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid persona" }, { status: 400 });
  const value = parsed.data;

  const outcome = await asUser(account.id, async (client) => {
    const current = await client.query("SELECT is_default FROM personas WHERE id=$1 AND user_id=$2", [id, account.id]);
    if (!current.rowCount) return { error: "Persona not found", status: 404 as const };
    if (current.rows[0].is_default && !value.isDefault) return { error: "Make another persona the default before unsetting this one", status: 409 as const };
    if (value.isDefault) await client.query("UPDATE personas SET is_default=false WHERE user_id=$1 AND is_default=true AND id<>$2", [account.id, id]);
    const result = await client.query(
      "UPDATE personas SET name=$1,description=$2,avatar_url=$3,avatar_path=$4,accent=$5,is_default=$6,updated_at=now() WHERE id=$7 AND user_id=$8 RETURNING *",
      [value.name,value.description,value.avatarUrl,value.avatarPath,value.accent,value.isDefault,id,account.id],
    );
    return result.rows[0] ? { row: result.rows[0] } : { error: "Persona not found", status: 404 as const };
  });

  if ("error" in outcome) return Response.json({ error: outcome.error }, { status: outcome.status });
  return Response.json({ persona: personaFromRow(outcome.row) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  const outcome = await asUser(account.id, async (client) => {
    const current = await client.query("SELECT is_default FROM personas WHERE id=$1 AND user_id=$2", [id, account.id]);
    if (!current.rowCount) return { error: "Persona not found", status: 404 as const };
    if (current.rows[0].is_default) return { error: "Choose another default persona before deleting this one", status: 409 as const };
    await client.query("DELETE FROM personas WHERE id=$1 AND user_id=$2", [id, account.id]);
    return { ok: true as const };
  });

  if ("error" in outcome) return Response.json({ error: outcome.error }, { status: outcome.status });
  return Response.json({ ok: true });
}
