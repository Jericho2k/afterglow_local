"use client";

import { useEffect, useState } from "react";
import { AtSign, Compass, UserRound } from "lucide-react";
import type { Profile } from "@/lib/types";
import { api } from "@/lib/api-client";
import { avatarSource, profileAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { uiStyles } from "@/components/ui";
import { PageHeader } from "./PageHeader";
import styles from "./shell.module.css";

/**
 * Profile.
 *
 * This is the creator identity, which is a different thing from a persona, and
 * the page says so rather than leaving it to be inferred. It shows only what
 * the profiles table actually holds — avatar, display name, username, bio —
 * and invents nothing: no follower count, no verification, no rank, no
 * analytics. A number that is not real is worse than no number.
 *
 * Setting a username is the single act that makes a profile public, so it is
 * given its own explanation rather than a nine-pixel caption.
 */

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

  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<{ profile: Profile }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ username, displayName, bio, avatarPath }),
      });
      onSaved(data.profile);
      setNotice("Profile saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your profile");
    } finally { setBusy(false); }
  }

  const source = avatarSource(profileAvatarBucket, avatarPath, "");
  const isPublic = Boolean(profile?.username);

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Your Afterglow account"
        title="Profile"
        lede="Your creator identity — the name and picture that appear beside anything you publish. It is separate from the personas you play as inside stories."
        onOpenMenu={onOpenMenu}
      />

      <div className={styles.stack} style={{ maxWidth: 620 }}>
        <section className={styles.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
            <span className={`${styles.avatar} ${styles.avatarLarge}`} aria-hidden>
              {source ? <img src={source} alt="" /> : initials(displayName)}
            </span>
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <label className={`${uiStyles.button} ${uiStyles.secondary}`} style={{ cursor: "pointer", justifySelf: "start" }}>
                Choose image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  style={{ display: "none" }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try { setAvatarPath(await uploadImage(file, profileAvatarBucket)); }
                    catch (reason) { setError(reason instanceof Error ? reason.message : "Image upload failed"); }
                  }}
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
                Choosing a username opts this profile into public creator attribution: your name and picture appear on the creations and worlds you publish. Leave it blank to stay anonymous — your work still publishes, without a byline.
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
