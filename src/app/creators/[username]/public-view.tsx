import { creatorLinkHost, creatorLinkRel } from "@/lib/creator-links";
import Link from "next/link";
import { Link as LinkIcon, Sparkles } from "lucide-react";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { compactCount } from "@/lib/format";
import { presentsAsAdult, safeShareTitle } from "@/lib/content-mode";
import type { PublicCreatorProfile } from "@/lib/public-view";
import styles from "./profile.module.css";

/**
 * A creator's shelf, for somebody who is not signed in.
 *
 * Adult-focused creations are listed rather than hidden — a body of work is
 * misdescribed by showing part of it — but each is drawn from what its own
 * gate would show: the outward name its creator nominated or neutral copy, and
 * no tagline, tags or totals. The SQL behind `publicCreatorCreations` blanks
 * those columns for a gated row, so this component is not the thing standing
 * between a gated creation and a public page; it is the second layer.
 */
function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function PublicCreatorView({ profile }: { profile: PublicCreatorProfile }) {
  const name = profile.displayName || profile.username;
  const links = profile.links ?? [];
  const avatar = avatarSource(profileAvatarBucket, profile.avatarPath, "");
  const signIn = `/?next=${encodeURIComponent(`/creators/${encodeURIComponent(profile.username)}`)}`;

  return <main className={styles.page}>
    <div className={styles.hero}>
      <div className={styles.cover}>
        <div className={styles.coverScrim} />
      </div>
      <div className={styles.identity}>
        <span className={styles.coverFallback}>
          {avatar ? <img src={avatar} alt="" /> : initials(name)}
        </span>
        <div className={styles.identityCopy}>
          <h1 className={styles.name}>{name}</h1>
          <p className={styles.handle}>@{profile.username}</p>
          <p className={styles.identityMeta}>
            <span>{compactCount(profile.followers)} followers</span>
            <span aria-hidden>·</span>
            <span>{compactCount(profile.publishedCreations)} creations</span>
          </p>
        </div>
      </div>
    </div>

    <div className={styles.body}>
      {(profile.bio || links.length > 0) && <section className={styles.card}>
        {profile.bio && <p className={styles.bio}>{profile.bio}</p>}
        {links.length > 0 && <ul className={styles.creatorLinks}>
        {links.map((link) => <li key={link.url}>
          {/*
            * Somebody else's URL, on a page anybody can open.
            *
            * `creatorLinkRel` carries the whole safety argument — noopener so
            * the opened tab gets no handle on this one, noreferrer so a
            * creator's audience is not told which page sent them, nofollow and
            * ugc so Afterglow is not lending its ranking to whatever this
            * points at. The protocol was already restricted to http(s) before
            * this value was stored; this is the second layer, not the first.
            */}
          <a href={link.url} rel={creatorLinkRel} target="_blank">
            <LinkIcon size={13} aria-hidden />
            <span>{link.label}</span>
            <small>{creatorLinkHost(link.url)}</small>
          </a>
        </li>)}
      </ul>}
      </section>}

      <section className={styles.card}>
        <h2 className={styles.eyebrow}>Published</h2>
        {profile.creations.length === 0
          ? <p className={styles.empty}>Nothing published yet.</p>
          : <ul className={styles.badgeGrid}>
            {profile.creations.map((creation) => {
              const gated = presentsAsAdult(creation.contentMode);
              const title = safeShareTitle({
                contentMode: creation.contentMode,
                shareTitle: creation.shareTitle,
                title: creation.title,
                name: creation.name,
                creatorUsername: profile.username,
              });
              const cover = creation.share.kind === "storage"
                ? avatarSource(characterAvatarBucket, creation.share.path, "")
                : creation.share.kind === "external" ? creation.share.url : "";
              return <li key={creation.id}>
                <Link href={`/characters/${creation.id}`} className={styles.chip}>
                  {cover
                    ? <img src={cover} alt="" loading="lazy" decoding="async" />
                    : <span aria-hidden>{initials(creation.name || title)}</span>}
                  <span>
                    <strong>{title}</strong>
                    {/* A gated row carries no tagline by the time it reaches
                        here; saying what it is instead of showing nothing is
                        the honest version of an empty line. */}
                    {gated ? <small>18+ · sign in to read</small> : creation.tagline && <small>{creation.tagline}</small>}
                  </span>
                </Link>
              </li>;
            })}
          </ul>}
      </section>

      <section className={styles.card}>
        <p className={styles.prose}>
          Following {name}, saving their work, and starting a story all need an account. Making one is free.
        </p>
        <Link className={styles.primaryAction} href={signIn}>
          <Sparkles size={18} /><span>Create a free account</span>
        </Link>
      </section>
    </div>
  </main>;
}
