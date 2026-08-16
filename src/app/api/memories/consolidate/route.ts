import { requireAuth } from "@/lib/auth";
import { maybeConsolidate } from "@/lib/memory";

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (typeof body.conversationId !== "string") return Response.json({ error: "conversationId is required" }, { status: 400 });
  try {
    const consolidated = await maybeConsolidate(body.conversationId,true);
    return Response.json({ ok: true, consolidated });
  } catch (error) {
    console.error("Manual consolidation failed",error);
    return Response.json({ error: error instanceof Error ? error.message : "Memory consolidation failed" }, { status: 502 });
  }
}
