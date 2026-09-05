import type { Metadata } from "next";
import { publicCreationPage, publicSafeLanding } from "@/lib/public-view";
import { indexableWithoutAccount, readableWithoutAccount, safeShareTitle } from "@/lib/content-mode";
import { absoluteUrl, metaDescription, shareImageUrl } from "@/lib/site";
import { characterAvatarBucket } from "@/lib/storage";
import { currentAccount } from "@/lib/session";
import CharacterProfile from "./profile";
import { AdultCreationGate, PublicCreationView } from "./public-view";

/**
 * What a crawler, a chat client and a search result see.
 *
 * Built from the safe landing model rather than the page, because this runs
 * for every mode and the gated one has no page. Everything here is outward
 * copy: `safeShareTitle` withholds an adult-focused creation's real title, the
 * description comes from the line its creator wrote for the outside, and the
 * image is only ever media the platform has classified safe.
 *
 * The gate is `noindex`. It renders correctly when somebody shares the link —
 * which is what the safe landing is for — but a search engine is not invited
 * to keep a page whose content it may not see.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const landing = await publicSafeLanding(id).catch(() => null);
  if (!landing) {
    // Private, unlisted, removed, or not a creation at all. All four are the
    // same answer to somebody who is not signed in, and none of them is a page
    // a search engine should keep.
    return { title: "Afterglow", robots: { index: false, follow: false } };
  }
  const open = readableWithoutAccount(landing.contentMode);
  const name = safeShareTitle({
    contentMode: landing.contentMode,
    shareTitle: landing.shareTitle,
    title: landing.title,
    name: landing.name,
    creatorUsername: landing.creator.username,
  });
  const description = metaDescription(
    landing.shareTagline,
    open ? "Chat with lasting memory on Afterglow." : "An 18+ creation on Afterglow. Sign in and confirm your age to read it.",
  );
  const image = shareImageUrl(landing.share, characterAvatarBucket, landing.accent);
  return {
    title: `${name} — Afterglow`,
    description,
    alternates: { canonical: absoluteUrl(`/characters/${landing.id}`) },
    robots: indexableWithoutAccount(landing.contentMode)
      ? { index: true, follow: true }
      : { index: false, follow: false },
    openGraph: {
      type: "profile",
      title: `${name} — Afterglow`,
      description,
      url: absoluteUrl(`/characters/${landing.id}`),
      images: [{ url: image, width: 1200, height: 630, alt: name }],
    },
    twitter: { card: "summary_large_image", title: `${name} — Afterglow`, description, images: [image] },
    other: open ? {} : { rating: "adult" },
  };
}

/**
 * One address, two readers.
 *
 * A signed-in reader gets the page they have always had — their save state,
 * their existing story, the report menu, everything that depends on who they
 * are. A visitor with no account gets the same page built from the anonymous
 * view model, or the gate when the creation is adult-focused.
 *
 * The branch is on the SESSION rather than on a fetch failing, so an anonymous
 * visitor never pays for a request that was always going to be refused, and
 * the public path renders on the server where a crawler can read it.
 */
export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await currentAccount();
  if (account) return <CharacterProfile characterId={id} />;

  const page = await publicCreationPage(id).catch(() => null);
  if (page) return <PublicCreationView page={page} />;
  const landing = await publicSafeLanding(id).catch(() => null);
  // No landing at all means private, unlisted, removed or absent. The signed-in
  // page answers that case properly — with a sign-in prompt for a reader who
  // may well have access once they are known — so it is what renders.
  return landing ? <AdultCreationGate landing={landing} /> : <CharacterProfile characterId={id} />;
}
