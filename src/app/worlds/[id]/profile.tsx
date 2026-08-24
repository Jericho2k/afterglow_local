"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Globe2, Sparkles } from "lucide-react";
import type { World } from "@/lib/types";
import { avatarSource, characterAvatarBucket, worldCoverBucket } from "@/lib/storage";
import { backFallbacks } from "@/lib/back-navigation";
import { BackButton } from "@/components/nav";
import styles from "./profile.module.css";

type WorldCharacter = { id: string; name: string; tagline: string; avatarPath: string; avatarUrl: string; accent: string };
type Detail = { world: World; owner: boolean; characters: WorldCharacter[] };

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/**
 * A world's own public page.
 *
 * Worlds are reusable: the same document can back many characters, so this
 * page belongs to the world rather than to whichever character linked here,
 * and it lists every character the viewer is allowed to see that uses it.
 */
export default function WorldProfile({ worldId }: { worldId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/worlds/${worldId}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open this world");
        setDetail(body);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this world"));
  }, [worldId]);

  if (error) return <main className={styles.state}><Globe2 size={26} /><h1>World unavailable</h1><p>{error}</p><Link href="/?view=worlds">Return to Worlds</Link></main>;
  if (!detail) return <main className={styles.state}><Globe2 size={26} className={styles.spin} /><h1>Opening world</h1></main>;

  const { world, characters } = detail;
  const cover = avatarSource(worldCoverBucket, world.coverPath, world.coverUrl);

  return <main className={styles.page}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {cover ? <img src={cover} alt="" /> : <span className={styles.heroFallback}><Globe2 size={64} /></span>}
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroBar}>
        <BackButton className={styles.circleButton} fallback={backFallbacks.world} />
      </div>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}><Sparkles size={13} />Reusable world</span>
        <h1>{world.name}</h1>
        {world.description && <p className={styles.tagline}>{world.description}</p>}
      </div>
    </div>

    <div className={styles.body}>
      {world.content && <section className={styles.card}>
        <header><Globe2 size={16} /><h2>Canon</h2></header>
        <p className={styles.prose}>{world.content}</p>
      </section>}

      {characters.length > 0 && <section className={styles.card}>
        <header><Sparkles size={16} /><h2>Characters in this world</h2></header>
        <ul className={styles.characters}>
          {characters.map((character) => {
            const image = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
            return <li key={character.id}>
              <Link href={`/characters/${character.id}`}>
                <span className={styles.avatar} style={{ "--accent": character.accent } as React.CSSProperties}>
                  {image ? <img src={image} alt="" /> : initials(character.name)}
                </span>
                <span>
                  <strong>{character.name}</strong>
                  {character.tagline && <small>{character.tagline}</small>}
                </span>
              </Link>
            </li>;
          })}
        </ul>
      </section>}
    </div>
  </main>;
}
