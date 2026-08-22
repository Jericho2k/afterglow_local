import { ownedConversation } from "@/lib/access";
import { asUser } from "@/lib/db";
import { maybeConsolidate } from "@/lib/memory";
import { checkRateLimit } from "@/lib/rate-limit";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied=adminRequired(account); if (denied) return denied;
  const limited = checkRateLimit(`consolidate:${account.id}`, 20, 60 * 60_000); if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  if (typeof body.conversationId !== "string") return Response.json({ error: "conversationId is required" }, { status: 400 });

  // Verified before the model call so an unowned id cannot spend tokens.
  const owns = await asUser(account.id, (client) => ownedConversation(client, account.id, body.conversationId));
  if (!owns) return Response.json({ error: "Conversation not found" }, { status: 404 });

  try {
    const consolidated = await maybeConsolidate(account.id, body.conversationId, true);
    return Response.json({ ok: true, consolidated });
  } catch (error) {
    console.error("Manual consolidation failed",error);
    return Response.json({ error: error instanceof Error ? error.message : "Memory consolidation failed" }, { status: 502 });
  }
}
