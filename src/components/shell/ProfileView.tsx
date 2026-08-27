"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AtSign, Compass, ExternalLink, MessageCircle, Sparkles, TrendingUp, UserRound, Users } from "lucide-react";
import type { Profile } from "@/lib/types";
import type { AchievementState } from "@/lib/achievements";
import { profileBorder, profileBorders, borderVariables, type ProfileBorderId } from "@/lib/cosmetics";
import { api } from "@/lib/api-client";
import { exactCount } from "@/lib/format";
import { avatarSource, profileAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { AchievementBadge, CreatorAvatar, CreatorStat, rankSummary } from "@/components/creator";
import { uiStyles } from "@/components/ui";
import { PageHeader } from "./PageHeader";
import styles from "./shell.module.css";

/**
 * Profile — the creator's own view of their identity.
 *
 * This used to be a form and nothing else, with a caption explaining that
 * Afterglow invents no follower counts, no rank and no analytics. Those numbers
 * are real now, so they are shown; the principle behind that caption has not
 * changed at all. Every figure here comes from the same aggregate the public
 * page reads, every achievement is a threshold on one of them, and a border
 * this account has not earned is not offered — the server checks that again on
 * save, so a client that offered one anyway would still not be able to equip it.
 *
 * Setting a username is still the single act that makes a profile public, and
 * it is still given its own explanation rather than a nine-pixel caption.
 */

type OwnProfile = Profile & {
  coverPath: string;
  profileBorder: string;
  featuredAchievements: string[];
};

type Standing = {
  stats: { followers: number; following: number; messages: number; creations: number; worlds: number };
  rank: { position: number | null; total: number; percentile: number | null };
  achievements: AchievementState[];
  unlockedBorders: string[];
};

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function ProfileView({ profile, onSaved, onOpenMenu }: {
  profile: Profile | null;
  onSaved: (profile: Profile) => void;
  onOpenMenu?: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [avatarPath, setAvatarPath] = useState(profile?.avatarPath ?? "");
  const [coverPath, setCoverPath] = useState("");
  const [border, setBorder] = useState<string>("default");
  const [featured, setFeatured] = useState<string[]>([]);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.displayName);
    setUsername(profile.username);
    setBio(profile.bio);
    setAvatarPath(profile.avatarPath);
  }, [profile]);

  /**
   * The creator's own standing, read once.
   *
   * The same endpoint the form saves through, so the cosmetics offered here
   * and the ones accepted on write are decided from one set of numbers rather
   * than two that could drift.
   */
  useEffect(() => {
    let live = true;
    void api<{ profile: OwnProfile } & Standing>("/api/profile")
      .then((data) => {
        if (!live) return;
        setCoverPath(data.profile.coverPath ?? "");
        setBorder(data.profile.profileBorder || "default");
        setFeatured(data.profile.featuredAchievements ?? []);
        setStanding({ stats: data.stats, rank: data.rank, achievements: data.achievements, unlockedBorders: data.unlockedBorders });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const save = useCallback(async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<{ profile: OwnProfile }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ username, displayName, bio, avatarPath, coverPath, profileBorder: border, featuredAchievements: featured }),
      });
      onSaved(data.profile);
      // The server is the authority on cosmetics, so the form takes back what
      // it actually stored rather than what it asked for.
      setBorder(data.profile.profileBorder || "default");
      setFeatured(data.profile.featuredAchievements ?? []);
      setNotice("Profile saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your profile");
    } finally { setBusy(false); }
  }, [username, displayName, bio, avatarPath, coverPath, border, featured, onSaved]);

  async function pickImage(file: File | undefined, apply: (path: string) => void) {
    if (!file) return;
    try { apply(await uploadImage(file, profileAvatarBucket)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image upload failed"); }
  }

  const avatarSrc = avatarSource(profileAvatarBucket, avatarPath, "");
  const coverSrc = avatarSource(profileAvatarBucket, coverPath, "");
  const isPublic = Boolean(profile?.username);
  const unlocked = new Set(standing?.unlockedBorders ?? ["default"]);
  const unlockedAchievements = (standing?.achievements ?? []).filter((achievement) => achievement.unlocked);
  const tier = standing ? rankSummary(standing.rank.position, standing.rank.total) : "";

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Your Afterglow account"
        title="Profile"
        lede="Your creator identity — the name, picture and standing that appear beside anything you publish. It is separate from the personas you play as inside stories."
        onOpenMenu={onOpenMenu}
      />

      <div className={styles.stack} style={{ maxWidth: 720 }}>
        {/* What the numbers actually are. Shown because they are real; a figure
            the backend cannot answer is still absent rather than zero. */}
        {standing && <section className={styles.card}>
          <div className={styles.profileStats}>
            <CreatorStat icon={<Users size={17} />} label="Followers" value={standing.stats.followers} />
            <CreatorStat icon={<MessageCircle size={17} />} label="Messages" value={standing.stats.messages} />
            <CreatorStat icon={<Sparkles size={17} />} label="Creations" value={standing.stats.creations} />
          </div>
          {standing.rank.position !== null && <p className={styles.profileRank}>
            <TrendingUp size={13} aria-hidden />
            <strong>#{exactCount(standing.rank.position)}</strong>
            <span>{tier} of {exactCount(standing.rank.total)} published creators</span>
          </p>}
          <p className={styles.fieldHint}>
            Messages counts what readers have sent to your published creations. Rank is ordered by that number, with
            followers, saves and published creations breaking ties.
          </p>
          {isPublic && <Link className={styles.profileLink} href={`/creators/${profile?.username}`}>
            View your public profile<ExternalLink size={14} aria-hidden />
          </Link>}
        </section>}

        <section className={styles.card}>
          {/* The banner, previewed at the shape it will actually occupy. */}
          <div className={styles.coverField}>
            <div className={styles.coverPreview}>
              {coverSrc ? <img src={coverSrc} alt="" /> : <span className={styles.coverEmpty} aria-hidden />}
              <div className={styles.coverAvatar}>
                <CreatorAvatar avatarPath={avatarPath} name={displayName || "You"} border={profileBorder(border)} size={64} />
              </div>
            </div>
            <div className={styles.coverActions}>
              <label className={`${uiStyles.button} ${uiStyles.secondary}`} style={{ cursor: "pointer" }}>
                {coverSrc ? "Change banner" : "Add banner"}
                <input
                  type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }}
                  onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; await pickImage(file, setCoverPath); }}
                />
              </label>
              {coverSrc && <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => setCoverPath("")}>Remove</button>}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "18px 0" }}>
            <span className={`${styles.avatar} ${styles.avatarLarge}`} aria-hidden>
              {avatarSrc ? <img src={avatarSrc} alt="" /> : initials(displayName)}
            </span>
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <label className={`${uiStyles.button} ${uiStyles.secondary}`} style={{ cursor: "pointer", justifySelf: "start" }}>
                Choose image
                <input
                  type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }}
                  onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; await pickImage(file, setAvatarPath); }}
                />
              </label>
              <span className={styles.fieldHint}>
                {isPublic
                  ? <><Compass size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />Visible to anyone who opens your creations.</>
                  : <><UserRound size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />Private until you choose a username.</>}
              </span>
            </div>
          </div>

          <div className={styles.stack}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="profile-name">Display name</label>
              <input id="profile-name" className={styles.input} value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="profile-username">Creator username</label>
              <div style={{ position: "relative" }}>
                <AtSign size={15} aria-hidden style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: .5, pointerEvents: "none" }} />
                <input
                  id="profile-username"
                  className={styles.input}
                  style={{ paddingLeft: 32 }}
                  value={username}
                  maxLength={30}
                  placeholder="your_username"
                  onChange={(event) => setUsername(event.target.value.toLowerCase())}
                />
              </div>
              <span className={styles.fieldHint}>
                Choosing a username opts this profile into public creator attribution: your name and picture appear on the creations and worlds you publish, and your profile gets a page of its own. Leave it blank to stay anonymous — your work still publishes, without a byline.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="profile-bio">Bio</label>
              <textarea
                id="profile-bio"
                className={styles.textarea}
                rows={7}
                maxLength={2000}
                value={bio}
                placeholder="What you create, the genres you like, and anything visitors should know…"
                onChange={(event) => setBio(event.target.value)}
              />
              <span className={styles.counter}>{bio.length.toLocaleString()} / 2,000</span>
            </div>

            {/* Cosmetics.
                Only what this account has earned is selectable, and the server
                checks the same thing again on save — a locked ring cannot be
                equipped by a client that decides to offer it anyway. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Profile border</span>
              <div className={styles.borderRow} role="radiogroup" aria-label="Profile border">
                {profileBorders.map((option) => {
                  const available = unlocked.has(option.id);
                  return <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={border === option.id}
                    aria-label={available ? option.label : `${option.label} — locked. ${option.requirement}`}
                    disabled={!available}
                    title={available ? option.label : option.requirement}
                    className={`${styles.borderSwatch} ${border === option.id ? styles.borderSwatchActive : ""}`}
                    style={borderVariables(option) as React.CSSProperties}
                    onClick={() => setBorder(option.id as ProfileBorderId)}
                  >
                    <span className={styles.borderRing} aria-hidden />
                    <small>{option.label}</small>
                  </button>;
                })}
              </div>
              <span className={styles.fieldHint}>
                Borders unlock from real milestones. A locked one shows what earns it.
              </span>
            </div>

            {unlockedAchievements.length > 0 && <div className={styles.field}>
              <span className={styles.fieldLabel}>Featured achievements</span>
              <span className={styles.fieldHint}>
                Choose up to three to lead with on your public profile. Leave them all unchecked and Afterglow shows the
                hardest things you have done.
              </span>
              <ul className={styles.featureGrid}>
                {unlockedAchievements.map((achievement) => {
                  const chosen = featured.includes(achievement.id);
                  return <li key={achievement.id}>
                    <button
                      type="button"
                      aria-pressed={chosen}
                      className={chosen ? styles.featureChosen : styles.feature}
                      onClick={() => setFeatured((current) => current.includes(achievement.id)
                        ? current.filter((id) => id !== achievement.id)
                        : current.length >= 3 ? current : [...current, achievement.id])}
                      disabled={!chosen && featured.length >= 3}
                    >{achievement.title}</button>
                  </li>;
                })}
              </ul>
            </div>}

            {standing && <div className={styles.field}>
              <span className={styles.fieldLabel}>Achievements</span>
              <ul className={styles.profileBadges}>
                {standing.achievements.map((achievement) => <AchievementBadge key={achievement.id} achievement={achievement} showLocked />)}
              </ul>
            </div>}

            {notice && <p className={styles.notice}>{notice}</p>}
            {error && <p className={styles.error}>{error}</p>}

            <button
              className={`${uiStyles.button} ${uiStyles.primary}`}
              style={{ justifySelf: "start" }}
              disabled={busy || !displayName.trim()}
              onClick={() => void save()}
            >{busy ? "Saving…" : "Save profile"}</button>
          </div>
        </section>
      </div>
    </div>
  </section>;
}
