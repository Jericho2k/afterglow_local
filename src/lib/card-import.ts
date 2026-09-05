import { bookToWorldLore, suggestedContentMode, type ParsedCard } from "./character-card";
import { canonicalTag, isPlatformTag, normalizeHashtag } from "./tags";
import type { ContentMode } from "./types";

/**
 * A parsed card, expressed as an Afterglow creation.
 *
 * The rule running through every line of this file is PRESERVE THE WORDS. A
 * creator who imports a card is not asking for an interpretation of their
 * character; they are asking for their character, in a different product. So
 * nothing here summarises, truncates, reorders sentences or "improves" tone,
 * and where two source fields have no single Afterglow equivalent they are
 * joined with a visible label rather than blended into one paragraph the
 * creator can no longer take apart.
 *
 * What this file DOES decide is which field goes where, and that mapping is
 * argued rather than assumed:
 *
 *   description → backstory   Afterglow's `description` is public page copy;
 *                             a card's `description` is the definition the
 *                             model reads. They are different fields with
 *                             confusingly similar names, and putting a card's
 *                             definition on the public page would publish
 *                             every creator's prompt.
 *   system_prompt → responseDirective   The nearest equivalent: instructions
 *                             about how to write rather than about who the
 *                             character is.
 *   creator_notes → sourceMaterial      Notes are FOR THE CREATOR. They
 *                             frequently contain "don't use this with X" or a
 *                             Discord handle, and they are never public.
 */

export type ImportedCreation = {
  name: string;
  title: string;
  tagline: string;
  backstory: string;
  personality: string;
  scenario: string;
  greeting: string;
  alternateGreetings: string[];
  exampleDialogue: string;
  responseDirective: string;
  tags: string[];
  hashtags: string[];
  avatarUrl: string;
  sourceMaterial: string;
  /** Lore for a World, kept out of the character's own fields. */
  lorebook: string;
  proposedWorld: { name: string; description: string } | null;
  /** A suggestion the creator confirms. Never applied without review. */
  contentMode: ContentMode;
  /** What was read, for the review screen to be honest about. */
  notes: string[];
};

/** Joins two authored blocks without merging them into one voice. */
function labelled(parts: { label: string; body: string }[]) {
  return parts
    .filter((part) => part.body.trim())
    .map((part, index) => (index === 0 && !part.label ? part.body.trim() : `${part.label}\n${part.body.trim()}`))
    .join("\n\n")
    .trim();
}

export function importedCreation(card: ParsedCard): ImportedCreation {
  const notes: string[] = [];

  /*
   * Tags split into the two systems Afterglow keeps separate.
   *
   * A card's tags are one undifferentiated list, and Afterglow has a curated
   * taxonomy plus freeform hashtags. Anything that matches the taxonomy becomes
   * a tag; everything else becomes a hashtag rather than being dropped, because
   * a creator's own vocabulary for their work is worth keeping even when this
   * platform has no column for it.
   */
  const tags: string[] = [];
  const hashtags: string[] = [];
  for (const raw of card.tags) {
    const canonical = canonicalTag(raw);
    // `canonicalTag` echoes an unknown tag back rather than rejecting it, so
    // membership is the question — "Romance" is taxonomy, "my own category" is
    // this creator's own word for their work and becomes a hashtag rather than
    // being invented into a platform tag or thrown away.
    if (isPlatformTag(canonical)) {
      if (!tags.includes(canonical)) tags.push(canonical);
    } else {
      const hashtag = normalizeHashtag(raw);
      if (hashtag && !hashtags.includes(hashtag)) hashtags.push(hashtag);
    }
  }

  /*
   * The response directive, from up to two source fields.
   *
   * `system_prompt` and `post_history_instructions` are different instructions
   * that happen to land in the same Afterglow field, so they arrive labelled.
   * A creator can see which was which and delete either; a blended paragraph
   * would have destroyed that distinction on import.
   */
  const responseDirective = labelled([
    { label: "", body: card.systemPrompt },
    { label: "From the card's post-history instructions:", body: card.postHistoryInstructions },
  ]);
  if (card.postHistoryInstructions.trim()) {
    notes.push("Post-history instructions were added to the response directive, labelled.");
  }

  const lorebook = card.book ? bookToWorldLore(card.book) : "";
  if (card.book) {
    notes.push(`${card.book.entries.length} lorebook ${card.book.entries.length === 1 ? "entry" : "entries"} became world lore.`);
  }
  if (card.groupOnlyGreetings.length) {
    notes.push(`${card.groupOnlyGreetings.length} group-only greetings were kept as alternate openings.`);
  }
  if (card.creatorNotes.trim()) {
    notes.push("Creator notes were kept privately with the import source, not published.");
  }

  /*
   * The source snapshot.
   *
   * The whole card as it arrived, plus the notes their author wrote. This is
   * the same field Paste Everything fills, it is owner-only, and it exists so
   * that a mapping decision made here is never the only copy of something: if
   * this file put a field in the wrong place, the original is still one screen
   * away.
   */
  const sourceMaterial = labelled([
    { label: "", body: card.creatorNotes ? `Creator notes\n${card.creatorNotes}` : "" },
    { label: "Imported card:", body: JSON.stringify(card.raw, null, 2) },
  ]);

  const name = card.name.trim();
  return {
    name,
    // A nickname is what the card says to CALL them, which is the better
    // public title when the two differ; `name` stays the character's own.
    title: card.nickname.trim() || name,
    // Deliberately empty. A tagline is public marketing copy written for
    // Afterglow's feed, and no card field means the same thing — inventing one
    // from the description would be exactly the silent rewriting this import
    // refuses to do.
    tagline: "",
    backstory: card.description,
    personality: card.personality,
    scenario: card.scenario,
    greeting: card.firstMessage,
    // Group-only greetings are still openings; Afterglow has no group chat, so
    // they join the alternates rather than being discarded.
    alternateGreetings: [...card.alternateGreetings, ...card.groupOnlyGreetings],
    exampleDialogue: card.exampleDialogue,
    responseDirective,
    tags,
    hashtags,
    avatarUrl: card.avatarUrl,
    sourceMaterial,
    lorebook,
    proposedWorld: card.book
      ? {
        name: card.book.name.trim() || (name ? `${name}'s world` : "Imported world"),
        description: card.book.description.trim(),
      }
      : null,
    contentMode: suggestedContentMode(card),
    notes,
  };
}
