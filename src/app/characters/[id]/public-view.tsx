import Link from "next/link";
import { BadgeCheck, Compass, Images, MessageCircle, Sparkles, Tag, Users } from "lucide-react";
import { castSectionLabel, creationTitle, inlineTitle } from "@/lib/creation";
import { contentModeBadge, readableWithoutAccount, safeShareTitle } from "@/lib/content-mode";
import { compactCount } from "@/lib/format";
import { accentVariables } from "@/lib/accent";
import { bannerArt } from "@/lib/art-presentation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { RichContent } from "@/components/rich";
import type { PublicCreationPage, PublicSafeLanding } from "@/lib/public-view";
import styles from "./profile.module.css";

/**
 * A public creation, rendered for somebody who is not signed in.
 *
 * This is the real page, not a teaser built to satisfy a crawler: the same
 * stylesheet, the same hero, the same sections in the same order, populated
 * from the anonymous view model. A visitor who arrives from a search result
 * sees what a member sees, minus the things that are inherently personal —
 * their save state, their existing story with this creation, the report menu.
 *
 * The one control that changes is the primary action. A member starts or
 * resumes a story; a visitor is asked to make an account, and is sent back
 * here afterwards rather than to a home feed they did not ask for.
 */

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function signInHref(path: string) {
  return `/?next=${encodeURIComponent(path)}`;
}

export function PublicCreationView({ page }: { page: PublicCreationPage }) {
  const title = creationTitle(page);
  const badge = contentModeBadge(page.contentMode);
  /*
   * The same framing decision as the signed-in page, from the same data.
   *
   * This is why `art` travels on the public view model at all: a visitor who
   * finds a creation through a search result must see the crop its creator
   * chose, not a second opinion formed by whichever component happened to
   * render it. `bannerArt` is the one place that decision is made.
   */
  const hero = bannerArt({
    avatarPath: page.art.avatarPath,
    avatarUrl: page.art.avatarUrl,
    bannerPath: page.art.bannerPath,
    bannerUrl: page.art.bannerUrl,
    presentation: page.art.presentation,
  });
  const image = avatarSource(characterAvatarBucket, hero.path, hero.url);
  const href = `/characters/${page.id}`;
  const creatorName = page.creatorProfile.displayName || page.creatorProfile.username;

  return <main className={styles.page} style={accentVariables(page.accent) as React.CSSProperties}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {image ? <img src={image} alt="" style={hero.style} /> : <span className={styles.heroFallback}>{initials(page.name)}</span>}
        <div className={styles.heroGlow} />
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroCopy}>
        <h1 className={styles.name}>{title}</h1>
        {page.tagline && <p className={styles.tagline}>{page.tagline}</p>}
        <p className={styles.byline}>
          {creatorName && <>
            {page.creatorProfile.username
              ? <Link className={styles.bylineCreator} href={`/creators/${encodeURIComponent(page.creatorProfile.username)}`}>{creatorName}</Link>
              : <strong>{creatorName}</strong>}
            <span aria-hidden>·</span>
          </>}
          <span>{compactCount(page.stats.chats)} chats</span>
        </p>
        <div className={styles.ctaRow}>
          {/*
            * The conversion point of the whole anonymous path.
            *
            * It says what happens next rather than "Sign up", because the
            * reader is here for a story and not for an account, and it carries
            * the page they are on so that making one returns them to it.
            */}
          <Link className={styles.primaryCta} href={signInHref(href)}>
            <Sparkles size={18} /><span>Chat with {inlineTitle(title)}</span>
          </Link>
        </div>
        <p className={styles.publicNote}>
          Free to start. Afterglow remembers your story between sessions.
          {page.contentMode === "adult_capable" && " Explicit scenes are off unless you turn them on and confirm you are 18 or over."}
        </p>
      </div>
    </div>

    <div className={styles.body}>
      {page.gallery.length > 0 && <section className={styles.card}>
        <header><Images size={16} /><h2>Gallery</h2></header>
        <ul className={styles.gallery}>
          {page.gallery.map((item) => <li key={item.id}>
            <img src={avatarSource(characterAvatarBucket, item.storagePath, item.externalUrl)} alt={item.caption} loading="lazy" decoding="async" />
          </li>)}
        </ul>
      </section>}

      {page.overview && <section className={styles.card}>
        <header><Sparkles size={16} /><h2>{page.creationType === "character" ? `About ${inlineTitle(title)}` : "Overview"}</h2></header>
        {page.overviewRich.length > 0
          ? <RichContent blocks={page.overviewRich} text={page.overview} bucket={characterAvatarBucket} />
          : <p className={`${styles.prose} ${styles.proseOpen}`}>{page.overview}</p>}
      </section>}

      {page.userRole.trim() && <section className={styles.card}>
        <header><Compass size={16} /><h2>Your role</h2></header>
        <p className={styles.roleProse}>{page.userRole}</p>
      </section>}

      {(page.tags.length > 0 || page.hashtags.length > 0) && <section className={styles.card}>
        <header><Tag size={16} /><h2>Tags</h2>{badge && <em className={styles.adultBadge}>{badge}</em>}</header>
        {page.tags.length > 0 && <ul className={styles.tagList}>{page.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
        {page.hashtags.length > 0 && <ul className={styles.hashtagList}>
          {page.hashtags.map((tag) => <li key={tag}><Link href={`/?q=%23${encodeURIComponent(tag)}`}>#{tag}</Link></li>)}
        </ul>}
        {page.contentMode === "adult_capable" && <p className={styles.adultNote}>
          This story can include consensual explicit content between fictional adults if you steer it there. It stays clean until you do.
        </p>}
      </section>}

      {page.quickFacts.length > 0 && <section className={styles.card}>
        <header><BadgeCheck size={16} /><h2>Quick facts</h2></header>
        <dl className={styles.facts}>
          {page.quickFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
        </dl>
      </section>}

      {page.cast.length > 0 && <section className={styles.card}>
        <header><Users size={16} /><h2>{castSectionLabel(page.creationType)}</h2><em className={styles.count}>{page.cast.length}</em></header>
        <ul className={styles.castList}>
          {page.cast.map((member, index) => {
            const portrait = avatarSource(characterAvatarBucket, member.avatarPath, member.avatarUrl);
            return <li key={member.key || `${member.name}-${index}`} className={styles.castCard}>
              <span className={styles.castLink}>
                <span className={styles.castAvatar}>{portrait ? <img src={portrait} alt="" decoding="async" /> : initials(member.name)}</span>
                <span className={styles.castCopy}>
                  <strong>{member.name}</strong>
                  {member.role && <small>{member.role}</small>}
                  {member.blurb && <p>{member.blurb}</p>}
                </span>
              </span>
            </li>;
          })}
        </ul>
      </section>}

      <section className={styles.card}>
        <header><MessageCircle size={16} /><h2>Start the story</h2></header>
        <p className={styles.prose}>
          Afterglow keeps what happens between you and {inlineTitle(title)} — the scene you are in, what you have told each other, and what it meant — so a story picked up next week is still the same story.
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.primaryCta} href={signInHref(href)}><Sparkles size={18} /><span>Create a free account</span></Link>
        </div>
      </section>
    </div>
  </main>;
}

/**
 * The gate an adult-focused creation shows instead of its page.
 *
 * A real landing page rather than a wall, built from the SAFE LANDING model
 * and nothing else: the outward name its creator nominated (or neutral copy
 * naming only them), the line they wrote for the outside, and media only if
 * the platform classified it safe. The creation's own title and tagline are
 * page copy written for somebody who already chose it, and they are not in
 * this component's input at all — so the gate cannot leak them by an edit.
 */
export function AdultCreationGate({ landing }: { landing: PublicSafeLanding }) {
  const href = `/characters/${landing.id}`;
  const name = safeShareTitle({
    contentMode: landing.contentMode,
    shareTitle: landing.shareTitle,
    title: landing.title,
    name: landing.name,
    creatorUsername: landing.creator.username,
  });
  const cover = landing.share.kind === "storage"
    ? avatarSource(characterAvatarBucket, landing.share.path, "")
    : landing.share.kind === "external" ? landing.share.url : "";

  return <main className={styles.page} style={accentVariables(landing.accent) as React.CSSProperties}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {cover ? <img src={cover} alt="" /> : <span className={styles.heroFallback}>18+</span>}
        <div className={styles.heroGlow} />
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroCopy}>
        <h1 className={styles.name}>{name}</h1>
        {landing.shareTagline && <p className={styles.tagline}>{landing.shareTagline}</p>}
        {landing.creator.username && <p className={styles.byline}>
          <Link className={styles.bylineCreator} href={`/creators/${encodeURIComponent(landing.creator.username)}`}>
            {landing.creator.displayName || landing.creator.username}
          </Link>
        </p>}
      </div>
    </div>
    <div className={styles.body}>
      <section className={styles.card}>
        <header><Tag size={16} /><h2>Adults only</h2><em className={styles.adultBadge}>18+</em></header>
        <p className={styles.prose}>
          Adult content is a core part of this creation, so its page and its chat are for signed-in readers who have confirmed they are 18 or over.
        </p>
        <p className={styles.adultNote}>
          Afterglow prohibits sexual content involving minors, non-consensual exploitation, and real people.
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.primaryCta} href={signInHref(href)}>
            <Sparkles size={18} /><span>Sign in or create an account</span>
          </Link>
        </div>
      </section>
      {landing.creator.username && <section className={styles.card}>
        <header><Users size={16} /><h2>More from this creator</h2></header>
        <p className={styles.prose}>
          <Link href={`/creators/${encodeURIComponent(landing.creator.username)}`}>
            See everything {landing.creator.displayName || landing.creator.username} has published
          </Link>
        </p>
      </section>}
    </div>
  </main>;
}

/** Chooses between the two, so a caller cannot render the wrong one. */
export function PublicCreation({ landing, page }: { landing: PublicSafeLanding; page: PublicCreationPage | null }) {
  return page && readableWithoutAccount(page.contentMode)
    ? <PublicCreationView page={page} />
    : <AdultCreationGate landing={landing} />;
}
