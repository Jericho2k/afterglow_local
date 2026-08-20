import { randomUUID } from "node:crypto";
import { asUser, personaFromRow } from "@/lib/db";
import { personaSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const result = await asUser(account.id, (client) =>
    client.query("SELECT * FROM personas WHERE user_id=$1 ORDER BY is_default DESC,updated_at DESC", [account.id]));
  return Response.json({ personas: result.rows.map(personaFromRow) });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = personaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid persona" }, { status: 400 });
  const id = randomUUID(); const value = parsed.data;

  const row = await asUser(account.id, async (client) => {
    // The default flag is unique per account, so clearing it is scoped too.
    if (value.isDefault) await client.query("UPDATE personas SET is_default=false WHERE user_id=$1 AND is_default=true", [account.id]);
    const result = await client.query(
      "INSERT INTO personas (id,user_id,name,description,avatar_url,avatar_path,accent,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [id,account.id,value.name,value.description,value.avatarUrl,value.avatarPath,value.accent,value.isDefault],
    );
    return result.rows[0];
  });

  return Response.json({ persona: personaFromRow(row) }, { status: 201 });
}
