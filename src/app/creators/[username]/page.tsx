import type { Metadata } from "next";
import { publicCreatorProfile } from "@/lib/public-view";
import { absoluteUrl, metaDescription, shareImageUrl } from "@/lib/site";
import { profileAvatarBucket } from "@/lib/storage";
import CreatorProfile from "./profile";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  const profile = await publicCreatorProfile(decodeURIComponent(username), 1).catch(() => null);
  if (!profile) return { title: "Afterglow", robots: { index: false, follow: false } };
  const name = profile.displayName || profile.username;
  const description = metaDescription(
    profile.bio,
    `${profile.publishedCreations} creation${profile.publishedCreations === 1 ? "" : "s"} on Afterglow`,
  );
  /*
   * A creator's own avatar, not their newest creation's cover.
   *
   * The shelf below can hold anything; the identity at the top is theirs, and
   * an avatar is the one image on this page whose suitability the account
   * holder answered for directly. It still passes through the same share
   * resolution — an empty avatar becomes the branded card, never a creation's
   * artwork borrowed for a preview.
   */
  const image = shareImageUrl(
    profile.avatarPath ? { kind: "storage", path: profile.avatarPath } : { kind: "fallback" },
    profileAvatarBucket,
  );
  return {
    title: `${name} — Afterglow`,
    description,
    alternates: { canonical: absoluteUrl(`/creators/${encodeURIComponent(profile.username)}`) },
    robots: { index: true, follow: true },
    openGraph: {
      type: "profile",
      title: `${name} — Afterglow`,
      description,
      url: absoluteUrl(`/creators/${encodeURIComponent(profile.username)}`),
      images: [{ url: image, width: 1200, height: 630, alt: name }],
    },
    twitter: { card: "summary_large_image", title: `${name} — Afterglow`, description, images: [image] },
  };
}

export default async function CreatorPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <CreatorProfile username={decodeURIComponent(username)} />;
}
