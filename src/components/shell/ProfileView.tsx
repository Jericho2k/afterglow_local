"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AtSign, Camera, Compass, ExternalLink, ImagePlus, MessageCircle, Sparkles, TrendingUp, UserRound, Users, X } from "lucide-react";
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
 * Edit profile — the creator's own view of their identity.
 *
 * Two things changed here, and they are the same thing twice.
 *
 * FIRST, this is no longer what "Profile" means. Profile is the public page at
 * /creators/{username}, because that is what a creator actually wants to look
 * at: how they appear to everybody else. This is the surface that CHANGES it,
 * reached from a button on that page, and it says so.
 *
 * SECOND, there is one avatar. This page used to draw a banner with the
 * creator's avatar and its earned ring overlapping it, and then — directly
 * below — a second, plain avatar with no ring at all, which was the one the
 * file picker actually wrote to. Two pictures of the same person, one wearing
 * the cosmetic and one not, and no way to tell which was the truth. The header
 * below IS the editable header: it looks like the public one because it is
 * built from the same components, and every control writes to the thing it is
 * drawn on top of.
 *
 * Every figure here comes from the same aggregate the public page reads, every
 * achievement is a threshold on one of them, and a border this account has not
 * earned is not offered — the server checks that again on save, so a client
 * that offered one anyway would still not be able to equip it.
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

  const coverSrc = avatarSource(profileAvatarBucket, coverPath, "");
  const isPublic = Boolean(profile?.username);
  const unlocked = new Set(standing?.unlockedBorders ?? ["default"]);
  const unlockedAchievements = (standing?.achievements ?? []).filter((achievement) => achievement.unlocked);
  const tier = standing ? rankSummary(standing.rank.position, standing.rank.total) : "";

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Your Afterglow account"
        title="Edit profile"
        lede="Your creator identity — the name, picture and standing that appear beside anything you publish. It is separate from the personas you play as inside stories."
        onOpenMenu={onOpenMenu}
        actions={isPublic && profile?.username
          ? <Link className={styles.profileLink} href={`/creators/${profile.username}`} style={{ marginTop: 0 }}>
              <ExternalLink size={14} aria-hidden />View public profile
            </Link>
          : undefined}
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

        </section>}

        <section className={styles.card}>
          {/*
            * The editable header, which is the header.
            *
            * Same banner proportions, same overlapping avatar, same earned ring
            * — because it is the same `CreatorAvatar` the public page draws,
            * given the border currently selected below. Change a ring and this
            * changes; change the picture and this changes. There is nothing
            * else on the page claiming to be the avatar, so there is nothing
            * else for it to disagree with.
            */}
          <div className={styles.editHeader}>
            <div className={styles.editCover}>
              {coverSrc ? <img src={coverSrc} alt="" /> : <span className={styles.coverEmpty} aria-hidden />}
              <div className={styles.editCoverScrim} aria-hidden />
              <label className={styles.editCoverButton}>
                <ImagePlus size={14} aria-hidden />
                <span>{coverSrc ? "Change cover" : "Add cover"}</span>
                <input
                  type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; await pickImage(file, setCoverPath); }}
                />
              </label>
              {coverSrc && <button
                type="button"
                className={styles.editCoverRemove}
                aria-label="Remove your cover image"
                onClick={() => setCoverPath("")}
              ><X size={14} aria-hidden /></button>}
            </div>

            <div className={styles.editIdentity}>
              <label className={styles.editAvatar} title="Change your profile picture">
                <CreatorAvatar avatarPath={avatarPath} name={displayName || "You"} border={profileBorder(border)} size={88} verified={isPublic} />
                <span className={styles.editAvatarBadge} aria-hidden><Camera size={15} /></span>
                <span className={styles.srOnly}>Change your profile picture</span>
                <input
                  type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; await pickImage(file, setAvatarPath); }}
                />
              </label>

              <div className={styles.editIdentityCopy}>
                {/* Live, from the fields below, so the header is a preview of
                    the real page rather than a snapshot of the last save. */}
                <strong>{displayName || "Your display name"}</strong>
                <small>{username ? `@${username}` : "No public handle yet"}</small>
                {bio.trim() && <p>{bio.trim()}</p>}
              </div>
            </div>
          </div>

          <p className={styles.fieldHint} style={{ marginTop: 14 }}>
            {isPublic
              ? <><Compass size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />This is how you appear on everything you publish.</>
              : <><UserRound size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />Publish a creation and this becomes your public creator page.</>}
          </p>

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
                Your handle is the address of your public creator page, and it is what readers see beside everything you publish. Publishing anything publicly gives you one automatically; this is where you change it to something you would rather be called.
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
