import { publicCreationPage, publicSafeLanding } from "@/lib/public-view";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * A public creation, for a caller who may not have an account.
 *
 * The only routes in the product that do not begin by resolving an account
 * live under `/api/public`, and each of them reads through `src/lib/
 * public-view.ts` and nothing else. That is the whole rule: an anonymous
 * request never touches `asUser`, never reaches a table directly, and never
 * receives an entity type that a private field could later be added to.
 *
 * The response shape says which half the caller got. `page` is the whole
 * public page and is absent for an adult-focused creation; `landing` is the
 * safe identity — name, creator, the creator's outward-facing line, nominated
 * media — and is always present. A signed-in reader does not come here: the
 * authenticated route returns their save state, their existing story and
 * everything else that depends on who they are.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = checkRateLimit(`public-creation:${clientIp(request)}`, 120, 60_000);
  if (limited) return limited;
  const { id } = await context.params;
  const [landing, page] = await Promise.all([publicSafeLanding(id), publicCreationPage(id)]);
  if (!landing) return Response.json({ error: "Not found" }, { status: 404 });
  // A landing without a page is an adult-focused creation: it exists, it is
  // public, and everything beyond its identity is behind the age gate.
  return Response.json({ landing, page, gated: !page });
}
