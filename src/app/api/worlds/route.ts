import { randomUUID } from "node:crypto";
import { asUser, worldFromRow } from "@/lib/db";
import { worldSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const worlds = await asUser(account.id, async (client) => {
    const result = await client.query("SELECT * FROM worlds WHERE user_id=$1 ORDER BY updated_at DESC", [account.id]);
    const links = await client.query(
      "SELECT cw.world_id FROM character_worlds cw JOIN characters c ON c.id=cw.character_id AND c.user_id=$1",
      [account.id],
    );
    return result.rows.map((row) => ({
      ...worldFromRow(row),
      characterCount: links.rows.filter((link) => String(link.world_id) === String(row.id)).length,
    }));
  });
  return Response.json({ worlds });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const id = randomUUID(); const value = parsed.data;
  const result = await asUser(account.id, (client) => client.query(
    "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [id,account.id,value.name,value.description,value.content,value.visibility],
  ));
  return Response.json({ world: worldFromRow(result.rows[0]) }, { status: 201 });
}
