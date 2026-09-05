import Link from "next/link";
import { Globe2, Sparkles } from "lucide-react";
import { avatarSource, worldCoverBucket } from "@/lib/storage";
import { compactCount } from "@/lib/format";
import type { PublicWorldCard } from "@/lib/public-view";
import styles from "./profile.module.css";

/**
 * A public world, for somebody who is not signed in.
 *
 * Deliberately the card and not the page. A world's lore is the whole of it,
 * and reading it has always been a signed-in act — the same rule that keeps a
 * creation's greeting off its public page. What a visitor gets is enough to
 * know what is being offered: its name, its one-line description, how many
 * people have saved it, and who made it.
 *
 * The cover only appears when the platform classified it safe; an unreviewed
 * one falls back to the same lettering a coverless world has always shown.
 */
export function PublicWorldView({ card }: { card: PublicWorldCard }) {
  const cover = card.share.kind === "storage"
    ? avatarSource(worldCoverBucket, card.share.path, "")
    : card.share.kind === "external" ? card.share.url : "";
  const signIn = `/?next=${encodeURIComponent(`/worlds/${card.id}`)}`;

  return <main className={styles.page}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {cover ? <img src={cover} alt="" /> : <span className={styles.heroFallback}><Globe2 size={28} aria-hidden /></span>}
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}>World</span>
        <h1>{card.name}</h1>
        {card.description && <p className={styles.tagline}>{card.description}</p>}
        <p className={styles.byline}>
          {card.creator.username && <>
            <Link href={`/creators/${encodeURIComponent(card.creator.username)}`}>
              {card.creator.displayName || card.creator.username}
            </Link>
            <span aria-hidden>·</span>
          </>}
          <span>{compactCount(card.saveCount)} saves</span>
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.primaryCta} href={signIn}>
            <Sparkles size={18} /><span>Open this world</span>
          </Link>
        </div>
      </div>
    </div>
    <div className={styles.body}>
      <section className={styles.card}>
        <p className={styles.prose}>
          The canon inside this world — its places, its factions, everything a story built on it knows — is written for readers with an account. Making one is free, and it lets you build your own stories on this world.
        </p>
      </section>
    </div>
  </main>;
}
