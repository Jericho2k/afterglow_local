import { randomUUID } from "node:crypto";
import { asUser } from "@/lib/db";
import { characterReportSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = characterReportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid report" }, { status: 400 });
  const value = parsed.data;
  const result = await asUser(account.id, (client) => client.query(
    `INSERT INTO character_reports (id,user_id,character_id,reason,details,character_name)
     SELECT $1,$2,c.id,$3,$4,c.name FROM characters c
     WHERE c.id=$5 AND c.user_id<>$2 AND c.visibility IN ('public','unlisted')
     RETURNING id`,
    [randomUUID(),account.id,value.reason,value.details,value.characterId],
  ));
  if (!result.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ ok: true, reportId: String(result.rows[0].id) }, { status: 201 });
}
