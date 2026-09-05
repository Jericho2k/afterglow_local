import { asUser } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { adultStateSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The reader's own adult state: what they have confirmed, and what they want.
 *
 * 0036 made both facts server-side and required them for adult content, and
 * then nothing in the product could set either — a signed-in reader could open
 * an adult-focused creation, send a message, and be told to confirm their age
 * with no way to do it. This route is the missing half.
 *
 * Two facts, deliberately not one, and this endpoint keeps them separable:
 *
 *   CONFIRMATION is an identity statement, made once. It is recorded as a
 *   timestamp because when somebody said it matters and how many times they
 *   said it does not, and it is written `COALESCE(adult_confirmed_at, now())`
 *   so the FIRST confirmation is the one that stands. Re-confirming cannot
 *   quietly move the date.
 *
 *   PREFERENCE is a setting, reversible at any time. Turning it off never
 *   erases the confirmation: a reader who says "not today" has not stopped
 *   being an adult, and asking them to prove their age again to undo a
 *   checkbox would be both insulting and a reason not to turn it off in the
 *   first place.
 *
 * The timestamp is never accepted from the client. A caller says THAT they
 * confirm, and the database says when.
 */

type AdultState = { confirmedAdult: boolean; confirmedAt: string | null; adultContentEnabled: boolean };

async function readState(userId: string): Promise<AdultState> {
  return asUser(userId, async (client) => {
    const profile = await client.query("SELECT adult_confirmed_at FROM profiles WHERE id=$1", [userId]);
    const settings = await client.query("SELECT adult_content_enabled FROM user_settings WHERE user_id=$1", [userId]);
    const confirmedAt = profile.rows[0]?.adult_confirmed_at ?? null;
    return {
      confirmedAdult: Boolean(confirmedAt),
      confirmedAt: confirmedAt ? new Date(String(confirmedAt)).toISOString() : null,
      adultContentEnabled: Boolean(settings.rows[0]?.adult_content_enabled),
    };
  });
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  return Response.json({ adult: await readState(account.id) });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  // Generous, because a reader flipping a preference twice is ordinary; bounded,
  // because this writes.
  const limited = checkRateLimit(`adult:${account.id}`, 40, 10 * 60_000);
  if (limited) return limited;

  const parsed = adultStateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const { confirm, adultContentEnabled } = parsed.data;

  const state = await asUser(account.id, async (client) => {
    if (confirm) {
      /*
       * COALESCE, so the first confirmation is the one on record.
       *
       * `now()` is the database's clock and the only source of this value —
       * the schema has no field for a caller to supply one, so a request
       * cannot backdate an account's confirmation to before a policy change.
       */
      await client.query(
        "UPDATE profiles SET adult_confirmed_at = COALESCE(adult_confirmed_at, now()), updated_at = now() WHERE id=$1",
        [account.id],
      );
    }

    if (adultContentEnabled !== undefined) {
      /*
       * Enabling requires a confirmation that already exists.
       *
       * The predicate is in the statement rather than in a branch above it, so
       * "you may not enable this without confirming" is enforced by the write
       * itself: a caller that posts `adultContentEnabled: true` alone updates
       * nothing. Disabling is unconditional — switching it off must always
       * work, whatever else is true.
       */
      await client.query(
        `UPDATE user_settings SET adult_content_enabled = $2, updated_at = now()
          WHERE user_id = $1
            AND ($2 = false OR EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND adult_confirmed_at IS NOT NULL))`,
        [account.id, adultContentEnabled],
      );
    }

    const profile = await client.query("SELECT adult_confirmed_at FROM profiles WHERE id=$1", [account.id]);
    const settings = await client.query("SELECT adult_content_enabled FROM user_settings WHERE user_id=$1", [account.id]);
    const confirmedAt = profile.rows[0]?.adult_confirmed_at ?? null;
    return {
      confirmedAdult: Boolean(confirmedAt),
      confirmedAt: confirmedAt ? new Date(String(confirmedAt)).toISOString() : null,
      adultContentEnabled: Boolean(settings.rows[0]?.adult_content_enabled),
    };
  });

  // The resolved state comes back so the client can update in place. A reader
  // who has just confirmed continues into the creation they were opening; they
  // do not reload, and nothing has to guess what the server decided.
  return Response.json({ adult: state });
}
