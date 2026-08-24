import { asUser } from "@/lib/db";
import { discoveryPreferencesSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Per-account Discovery preferences.
 *
 * What somebody generally wants to see when they open Discovery, as distinct
 * from what they are looking at right now. The two are easy to conflate and
 * must not be: the current view lives in the URL, where Back can restore it,
 * and the preference lives here, where a new session can pick it up.
 *
 * It sits on the existing per-account `user_settings` row rather than in a new
 * table — that row already has row level security, already survives sign-out
 * and sign-in, and already follows the account to another device. Nothing here
 * is shared between accounts using the same browser, which local storage could
 * not have promised.
 *
 * The stored object is validated on the way out as well as in: a value written
 * by an older build, or a tag the taxonomy has since dropped, is ignored
 * rather than trusted into a query.
 */

const empty = { sort: undefined, tags: [], types: [], includeAdult: false } as const;

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const discovery = await asUser(account.id, async (client) => {
    const result = await client.query("SELECT discovery_preferences FROM user_settings WHERE user_id=$1", [account.id]);
    const parsed = discoveryPreferencesSchema.safeParse(result.rows[0]?.discovery_preferences ?? {});
    return parsed.success ? parsed.data : {};
  });
  return Response.json({ discovery: { ...empty, ...discovery } });
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = discoveryPreferencesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid preferences" }, { status: 400 });

  const discovery = await asUser(account.id, async (client) => {
    // The row is created on first read everywhere else in the product, so it
    // is created here too rather than failing for an account that has never
    // opened settings.
    await client.query(
      "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id",
      [account.id],
    );
    const result = await client.query(
      "UPDATE user_settings SET discovery_preferences=$1::jsonb,updated_at=now() WHERE user_id=$2 RETURNING discovery_preferences",
      [JSON.stringify(parsed.data), account.id],
    );
    const stored = discoveryPreferencesSchema.safeParse(result.rows[0]?.discovery_preferences ?? {});
    return stored.success ? stored.data : {};
  });

  return Response.json({ discovery: { ...empty, ...discovery } });
}
