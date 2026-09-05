import type { Metadata } from "next";
import { publicWorldCard } from "@/lib/public-view";
import { indexableWithoutAccount, readableWithoutAccount } from "@/lib/content-mode";
import { absoluteUrl, metaDescription, shareImageUrl } from "@/lib/site";
import { worldCoverBucket } from "@/lib/storage";
import { currentAccount } from "@/lib/session";
import WorldProfile from "./profile";
import { PublicWorldView } from "./public-view";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await publicWorldCard(id).catch(() => null);
  if (!card) return { title: "Afterglow", robots: { index: false, follow: false } };
  const gated = !readableWithoutAccount(card.contentMode);
  const description = metaDescription(
    card.description,
    gated ? "An 18+ world on Afterglow." : "A reusable world on Afterglow.",
  );
  const image = shareImageUrl(card.share, worldCoverBucket);
  return {
    title: `${card.name} — Afterglow`,
    description,
    alternates: { canonical: absoluteUrl(`/worlds/${card.id}`) },
    robots: indexableWithoutAccount(card.contentMode) ? { index: true, follow: true } : { index: true, follow: false },
    openGraph: {
      type: "article",
      title: `${card.name} — Afterglow`,
      description,
      url: absoluteUrl(`/worlds/${card.id}`),
      images: [{ url: image, width: 1200, height: 630, alt: card.name }],
    },
    twitter: { card: "summary_large_image", title: `${card.name} — Afterglow`, description, images: [image] },
    other: gated ? { rating: "adult" } : {},
  };
}

/**
 * One address, two readers. See the creation page for the reasoning.
 *
 * A world's anonymous form is a card rather than a page, because the lore IS
 * the world and reading it is a signed-in act — the same rule that has always
 * kept a creation's greeting off its public page. An unclassified world has no
 * anonymous form at all, so it falls through to the signed-in page.
 */
export default async function WorldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await currentAccount();
  if (account) return <WorldProfile worldId={id} />;
  const card = await publicWorldCard(id).catch(() => null);
  return card ? <PublicWorldView card={card} /> : <WorldProfile worldId={id} />;
}
