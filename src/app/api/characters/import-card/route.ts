import { importedCreation } from "@/lib/card-import";
import { parseCard } from "@/lib/character-card";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Reading an uploaded character card.
 *
 * Deliberately NOT `/api/characters/generate`. That endpoint sends material to
 * a model and gets an interpretation back; this one parses a structured file
 * and returns exactly what was in it. No model is called, nothing is billed,
 * and no wording changes — which is the entire promise of a card import to
 * somebody who spent months on a character elsewhere.
 *
 * It also creates nothing. The response is an unsaved draft: the studio opens
 * with it populated, the creator reviews and edits, and only their save writes
 * a row. That ordering is what makes the content-mode suggestion safe to
 * make at all — the import cannot publish, so a wrong guess costs a correction
 * rather than an exposure.
 *
 * The image is not sent here. The browser uploads the original file straight to
 * storage through the same path every other image takes, so the bytes a creator
 * chose are the bytes that get stored: this route reads metadata out of a copy
 * and never re-encodes anything.
 */

/** Cards are small; the artwork inside them is not. 8 MB is a generous card. */
const maxCardBytes = 8_000_000;

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`import-card:${account.id}`, 30, 10 * 60_000);
  if (limited) return limited;

  const body = await request.arrayBuffer().catch(() => null);
  if (!body || !body.byteLength) return Response.json({ error: "Choose a character card file to import." }, { status: 400 });
  if (body.byteLength > maxCardBytes) {
    return Response.json({ error: "That file is larger than 8 MB. Character cards are usually well under that." }, { status: 413 });
  }

  const card = parseCard(new Uint8Array(body));
  if (!card) {
    return Response.json({
      error: "That file does not contain character card data. Afterglow reads SillyTavern and Chub cards — a PNG with embedded card data, or a character card JSON file.",
    }, { status: 422 });
  }

  const creation = importedCreation(card);
  return Response.json({
    creation,
    spec: card.spec,
    notes: creation.notes,
    /*
     * Said out loud rather than assumed.
     *
     * The studio shows this so the creator knows a classification was GUESSED
     * from the card's own tags and is theirs to change — the difference between
     * a suggestion and a decision has to be visible at the moment of review,
     * not buried in a field that happens to be pre-filled.
     */
    suggestedContentMode: creation.contentMode,
  });
}
