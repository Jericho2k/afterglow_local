import { asUser, worldFromRow } from "@/lib/db";
import { worldSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const value = parsed.data;
  const result = await asUser(account.id, (client) => client.query(
    "UPDATE worlds SET name=$1,description=$2,content=$3,visibility=$4,updated_at=now() WHERE id=$5 AND user_id=$6 RETURNING *",
    [value.name,value.description,value.content,value.visibility,id,account.id],
  ));
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ world: worldFromRow(result.rows[0]) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const result = await asUser(account.id, (client) => client.query("DELETE FROM worlds WHERE id=$1 AND user_id=$2", [id, account.id]));
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ ok: true });
}
