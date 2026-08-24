"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkles, UserRound } from "lucide-react";
import { accentVariables } from "@/lib/accent";
import { backFallbacks } from "@/lib/back-navigation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { PublicCastMember } from "@/lib/cast";
import { BackButton } from "@/components/nav";
import { iconButtonClass } from "@/components/ui";
import styles from "./member.module.css";

type Detail = {
  member: PublicCastMember;
  creation: { id: string; title: string; accent: string };
  owner: boolean;
};

/**
 * A cast member's own page.
 *
 * Lightweight on purpose. This is a subresource of its creation, not a
 * standalone bot: it has a portrait, a name, the role and blurb the creator
 * wrote for readers, and a way back into the creation it belongs to. It does
 * not have a chat button, because a cast member is not something you chat with
 * separately — the creation is.
 *
 * Nothing hidden reaches it. The route selects the member's public half only,
 * so there is no definition, no response directive and no creator note here to
 * leak, and access is inherited from the parent creation rather than decided
 * again.
 */
export default function CastMemberProfile({ creationId, memberId }: { creationId: string; memberId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/characters/${creationId}/cast/${encodeURIComponent(memberId)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open this character");
        setDetail(body);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this character"));
  }, [creationId, memberId]);

  if (error) return <main className={styles.state}>
    <UserRound size={26} /><h1>Character unavailable</h1><p>{error}</p>
    <Link href={`/characters/${creationId}`}>Back to the creation</Link>
  </main>;
  if (!detail) return <main className={styles.state}><Sparkles size={26} className={styles.spin} /><h1>Opening character</h1></main>;

  const { member, creation } = detail;
  const portrait = avatarSource(characterAvatarBucket, member.avatarPath, member.avatarUrl);
  const initials = member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";

  return <main className={styles.page} style={accentVariables(creation.accent) as React.CSSProperties}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {portrait ? <img src={portrait} alt="" /> : <span className={styles.heroFallback}>{initials}</span>}
        <div className={styles.heroGlow} />
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroBar}>
        {/* Back is history, and the fallback for a member opened cold is the
            creation it belongs to rather than the feed — that is the page it
            is a part of. */}
        <BackButton className={iconButtonClass("media")} fallback={backFallbacks.castMember(creation.id)} />
      </div>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}>From {creation.title}</span>
        <h1>{member.name}</h1>
        {member.role && <p className={styles.role}>{member.role}</p>}
      </div>
    </div>

    <div className={styles.body}>
      {member.tagline && <section className={styles.card}>
        <header><UserRound size={16} /><h2>About {member.name}</h2></header>
        <p className={styles.prose}>{member.tagline}</p>
      </section>}

      <section className={styles.card}>
        <header><Sparkles size={16} /><h2>Part of</h2></header>
        <Link href={`/characters/${creation.id}`} className={styles.parentLink}>
          <span>
            <strong>{creation.title}</strong>
            <small>Open the full creation to read everything and start a story</small>
          </span>
          <ArrowUpRight size={17} aria-hidden />
        </Link>
      </section>
    </div>
  </main>;
}
