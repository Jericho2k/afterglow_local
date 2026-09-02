import { ownedConversation } from "@/lib/access";
import { asUser } from "@/lib/db";
import {
  availabilityForTask, backgroundCandidate, backgroundRoute, backgroundRouteConfig, backgroundTasks,
  candidateAvailability, clearBackgroundRoute, isBackgroundTask, setBackgroundRoute, type BackgroundTask,
} from "@/lib/background-routing";
import { checkRateLimit } from "@/lib/rate-limit";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";

/**
 * THE ADMIN CONTROL FOR BACKGROUND INFERENCE.
 *
 * One page's worth of API: what the candidates are, which one each job is
 * currently running on and why, and how to change it. The point of it existing
 * at all is that switching the memory extractor should be something an operator
 * does before lunch and reverses after it, rather than a deploy — because the
 * question it answers ("is the cheap one as good?") can only be answered by
 * running both for a while against real stories.
 *
 * TWO SCOPES, AND THE NARROW ONE IS NOT A SHORTCUT TO THE WIDE ONE.
 * A PUT with no `conversationId` sets the deployment-wide default. A PUT with
 * one sets an override on that single conversation, which must be one the
 * administrator's own account owns — an administrator has diagnostics over
 * their own stories, not over anybody else's, and `ownedConversation` is what
 * keeps this endpoint from becoming a way to reach into another account.
 *
 * NOTHING HERE REWRITES HISTORY. Changing a route changes which model does the
 * next piece of background work and nothing else; no memory, summary, arc or
 * canon entry is regenerated. There is no endpoint for that, deliberately.
 */

type Body = {
  task?: string;
  candidateId?: string;
  conversationId?: string;
  /** True clears the setting rather than replacing it. */
  reset?: boolean;
};

/** Which conversation column an override for this task lives in. */
const overrideColumn: Record<BackgroundTask, "memory_model_override" | "scene_model_override"> = {
  // Consolidation and curation share one column on purpose: "which model does
  // the memory work on this story" is one intention, and splitting it into two
  // settings makes a half-applied experiment easy to create by accident.
  memory_consolidation: "memory_model_override",
  memory_curation: "memory_model_override",
  scene_state: "scene_model_override",
};

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  const overrides = conversationId
    ? await asUser(account.id, async (client) => {
      if (!(await ownedConversation(client, account.id, conversationId))) return null;
      const row = (await client.query(
        "SELECT memory_model_override,scene_model_override FROM conversations WHERE id=$1 AND user_id=$2",
        [conversationId, account.id],
      )).rows[0];
      return {
        memory: (row?.memory_model_override as string | null) ?? null,
        scene: (row?.scene_model_override as string | null) ?? null,
      };
    })
    : undefined;
  if (conversationId && !overrides) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const stored = await backgroundRouteConfig();
  const tasks = [];
  for (const task of backgroundTasks) {
    const override = overrides ? (overrideColumn[task] === "scene_model_override" ? overrides.scene : overrides.memory) : null;
    const effective = await backgroundRoute(task, { overrideCandidateId: override });
    tasks.push({
      task,
      /** What the administrator has stored globally, or null for "not set". */
      globalCandidateId: stored.get(task) ?? null,
      /** The conversation override, when one conversation was asked about. */
      conversationCandidateId: overrides ? override : undefined,
      /** What would actually run right now, and which layer decided it. */
      effective: {
        candidateId: effective.candidateId,
        source: effective.source,
        providerId: effective.selection?.providerId ?? null,
        modelId: effective.selection?.modelId ?? null,
      },
      candidates: availabilityForTask(task).map((entry) => ({
        id: entry.candidate.id,
        label: entry.candidate.label,
        description: entry.candidate.description,
        providerId: entry.candidate.selection?.providerId ?? null,
        modelId: entry.candidate.selection?.modelId ?? null,
        /** The exact OpenRouter routing tag this candidate pins, suffix included. */
        upstreamProvider: entry.candidate.upstreamProvider ?? null,
        /** True when an operator must name that host before this can be chosen. */
        requiresUpstreamOptIn: entry.candidate.requiresUpstreamOptIn,
        selectable: entry.selectable,
        reason: entry.reason,
      })),
    });
  }
  return Response.json({ tasks });
}

export async function PUT(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;
  const limited = checkRateLimit(`background-routing:${account.id}`, 60, 60 * 60_000); if (limited) return limited;

  const body = await request.json().catch(() => ({})) as Body;
  if (typeof body.task !== "string" || !isBackgroundTask(body.task)) {
    return Response.json({ error: `task must be one of ${backgroundTasks.join(", ")}` }, { status: 400 });
  }
  const task = body.task;
  const reset = body.reset === true;
  if (!reset && typeof body.candidateId !== "string") {
    return Response.json({ error: "candidateId is required unless reset is true" }, { status: 400 });
  }

  if (typeof body.conversationId === "string") {
    const conversationId = body.conversationId;
    /*
     * An override is stored only when it would actually be honoured.
     *
     * `backgroundRoute` falls through an unselectable override rather than
     * failing on it, which is the right behaviour at 3am and the wrong answer
     * to give an administrator at the moment they set one: they would see the
     * value saved and the model unchanged, with nothing to explain it.
     */
    if (!reset) {
      const candidate = backgroundCandidate(body.candidateId!);
      if (!candidate) return Response.json({ error: "That is not a known background model" }, { status: 400 });
      const availability = candidateAvailability(task, candidate);
      if (!availability.selectable) {
        return Response.json({ error: availability.reason || "That model is not selectable for this job" }, { status: 409 });
      }
    }
    const updated = await asUser(account.id, async (client) => {
      if (!(await ownedConversation(client, account.id, conversationId))) return false;
      await client.query(
        `UPDATE conversations SET ${overrideColumn[task]}=$1,updated_at=now() WHERE id=$2 AND user_id=$3`,
        [reset ? null : body.candidateId, conversationId, account.id],
      );
      return true;
    });
    if (!updated) return Response.json({ error: "Conversation not found" }, { status: 404 });
    const effective = await backgroundRoute(task, { overrideCandidateId: reset ? null : body.candidateId });
    return Response.json({ ok: true, scope: "conversation", task, candidateId: reset ? null : body.candidateId, effective });
  }

  if (reset) {
    await clearBackgroundRoute(task);
    return Response.json({ ok: true, scope: "global", task, candidateId: null, effective: await backgroundRoute(task) });
  }

  try {
    await setBackgroundRoute(task, body.candidateId!, account.id);
  } catch (error) {
    // The storage layer refuses an unselectable candidate, and its message is
    // the actionable one — which host to verify, which provider to enable.
    return Response.json({ error: error instanceof Error ? error.message : "That model could not be selected" }, { status: 409 });
  }
  return Response.json({ ok: true, scope: "global", task, candidateId: body.candidateId, effective: await backgroundRoute(task) });
}
