import { publicCreatorProfile } from "@/lib/public-view";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * A creator's public shelf, for a caller who may not have an account.
 *
 * Adult-focused creations are listed as cards. Hiding them would misdescribe
 * what a creator has published, and a card is the half that is safe to show
 * anywhere — the link on it leads to that creation's gate.
 */
export async function GET(request: Request, context: { params: Promise<{ username: string }> }) {
  const limited = checkRateLimit(`public-creator:${clientIp(request)}`, 120, 60_000);
  if (limited) return limited;
  const { username } = await context.params;
  const profile = await publicCreatorProfile(decodeURIComponent(username));
  if (!profile) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ profile });
}
