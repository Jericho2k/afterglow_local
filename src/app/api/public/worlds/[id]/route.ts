import { publicWorldCard } from "@/lib/public-view";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { readableWithoutAccount } from "@/lib/content-mode";

/**
 * A public world's card. Never its lore — see `publicWorldCard`.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = checkRateLimit(`public-world:${clientIp(request)}`, 120, 60_000);
  if (limited) return limited;
  const { id } = await context.params;
  const card = await publicWorldCard(id);
  if (!card) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ card, gated: !readableWithoutAccount(card.contentMode) });
}
