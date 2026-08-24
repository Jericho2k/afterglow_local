import { castMembersFromRow } from "@/lib/db";
import { asUser } from "@/lib/db";
import { findCastMember, publicCastMember } from "@/lib/cast";
import { creationTitle } from "@/lib/creation";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * One cast member's public page.
 *
 * A cast member is a subresource of its creation, never a creation of its
 * own: it is not discoverable, not chattable and not published separately.
 * Everything about access follows from that — the member is readable exactly
 * where its parent is, which is why the parent's visibility predicate is the
 * only authorisation check here and why a draft's cast has no public page.
 *
 * What comes back is the member's public half only. Its `description` is the
 * definition that steers the model — the same class of material as a response
 * directive — and it is not selected into the response at all rather than
 * being blanked out afterwards.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string; memberId: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id, memberId } = await context.params;

  const detail = await asUser(account.id, async (client) => {
    // Only the columns a member page needs. The creation's own hidden
    // definition is not read here either.
    const result = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.accent,c.cast_members,c.visibility
       FROM characters c
       WHERE c.id=$1 AND (c.user_id=$2 OR c.visibility IN ('public','unlisted'))`,
      [id, account.id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const member = findCastMember(castMembersFromRow(row.cast_members), memberId);
    if (!member) return null;
    return {
      member: publicCastMember(member),
      creation: {
        id: String(row.id),
        title: creationTitle({
          title: String(row.title || ""),
          name: String(row.name || ""),
          creationType: String(row.creation_type || "") as "character" | "cast" | "scenario",
          profileType: row.profile_type === "ensemble" ? "ensemble" : "single",
        }),
        // The member page inherits its parent's accent rather than having one
        // of its own: a cast reads as one creation, not as several themes.
        accent: String(row.accent || "#e879a9"),
      },
      owner: String(row.user_id ?? "") === account.id,
    };
  });

  if (!detail) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json(detail);
}
