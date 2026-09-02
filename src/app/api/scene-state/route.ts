import { ownedConversation } from "@/lib/access";
import { asUser } from "@/lib/db";
import { sceneStateEnabled } from "@/lib/memory-flags";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentSceneState, maybeUpdateSceneState, sceneStateHistory } from "@/lib/scene-state-store";
import { renderCurrentScene, renderSceneLedger, sceneFieldsOf } from "@/lib/scene-state";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";

/**
 * Scene State diagnostics.
 *
 * Administrator-only, and account-scoped on top of that: the conversation
 * predicate means an administrator still cannot read somebody else's scene.
 * Nothing here is exposed to ordinary users — Scene State is internal metadata
 * and never appears next to a roleplay reply.
 */
export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) return Response.json({ error: "conversationId is required" }, { status: 400 });

  const payload = await asUser(account.id, async (client) => {
    if (!(await ownedConversation(client, account.id, conversationId))) return null;
    const current = await currentSceneState(client, account.id, conversationId);
    return {
      enabled: sceneStateEnabled(account.id),
      current,
      /*
       * TWO RENDERINGS, BECAUSE THEY ANSWER TWO QUESTIONS.
       *
       * `rendered` is the ledger's FACTS and is what the panel shows. It used
       * to be the writer's block, which meant the diagnostic displayed
       * "Everyone listed under Present is still here. Do not write them out of
       * the scene…" as though the ledger held that — an instruction to a model
       * presented to a human as stored state.
       *
       * `writerBlock` keeps the original purpose: exactly what the writer
       * receives, so the prompt can be compared with the diagnostic rather than
       * approximated from it. Nothing renders it by default; it is there for
       * the question "is the prompt getting what I think it is".
       */
      rendered: current ? renderSceneLedger(sceneFieldsOf(current)) : "",
      writerBlock: current ? renderCurrentScene(sceneFieldsOf(current)) : "",
      history: await sceneStateHistory(client, account.id, conversationId),
    };
  });

  if (!payload) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json(payload);
}

/** Forces one extraction, for verifying a chat by hand. */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;
  const limited = checkRateLimit(`scene-state:${account.id}`, 30, 60 * 60_000); if (limited) return limited;
  const body = await request.json().catch(() => ({})) as { conversationId?: string };
  if (typeof body.conversationId !== "string") return Response.json({ error: "conversationId is required" }, { status: 400 });
  if (!sceneStateEnabled(account.id)) return Response.json({ error: "Scene State is not enabled for this account" }, { status: 409 });

  // Verified before the model call so an unowned id cannot spend tokens.
  const owns = await asUser(account.id, (client) => ownedConversation(client, account.id, body.conversationId!));
  if (!owns) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const updated = await maybeUpdateSceneState(account.id, body.conversationId, true);
  const current = await asUser(account.id, (client) => currentSceneState(client, account.id, body.conversationId!));
  return Response.json({ ok: true, updated, current });
}
