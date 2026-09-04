import type { Metadata } from "next";
import { publicCreationCard } from "@/lib/public-view";
import { creationTitle } from "@/lib/creation";
import { indexableWithoutAccount, readableWithoutAccount } from "@/lib/content-mode";
import { absoluteUrl, metaDescription, shareImageUrl } from "@/lib/site";
import { characterAvatarBucket } from "@/lib/storage";
import CharacterProfile from "./profile";

/**
 * What a crawler, a chat client and a search result see.
 *
 * This is the half of a public creation page that has to work without an
 * account, and it reads through the anonymous view model rather than the
 * authenticated API for that reason: `generateMetadata` runs with no session
 * for exactly the visitors this is for.
 *
 * Every creation that is public gets a title, a description and an image,
 * whatever its content mode — a shared link must not be a blank card. What
 * differs by mode is `robots`: an adult-focused page invites indexing of its
 * gate, which carries only the identity a card already shows, while its
 * contents stay behind the sign-in and the age confirmation.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await publicCreationCard(id).catch(() => null);
  if (!card) {
    // Private, unlisted, removed, or not a creation at all. All four are the
    // same answer to somebody who is not signed in, and none of them is a page
    // a search engine should keep.
    return { title: "Afterglow", robots: { index: false, follow: false } };
  }
  const name = creationTitle(card) || card.name;
  const gated = !readableWithoutAccount(card.contentMode);
  const description = metaDescription(
    card.tagline,
    gated ? "An 18+ creation on Afterglow. Sign in and confirm your age to read it." : "Chat with lasting memory on Afterglow.",
  );
  const image = shareImageUrl(card.share, characterAvatarBucket, card.accent);
  return {
    title: `${name} — Afterglow`,
    description,
    alternates: { canonical: absoluteUrl(`/characters/${card.id}`) },
    robots: indexableWithoutAccount(card.contentMode)
      ? { index: true, follow: true }
      // The gate itself may be indexed — it is the safe card — but nothing
      // beyond it exists to crawl, and `follow` would only walk back into the
      // same wall.
      : { index: true, follow: false },
    openGraph: {
      type: "profile",
      title: `${name} — Afterglow`,
      description,
      url: absoluteUrl(`/characters/${card.id}`),
      images: [{ url: image, width: 1200, height: 630, alt: name }],
    },
    twitter: { card: "summary_large_image", title: `${name} — Afterglow`, description, images: [image] },
    other: gated ? { rating: "adult" } : {},
  };
}

export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CharacterProfile characterId={id} />;
}
