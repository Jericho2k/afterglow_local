"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Trash2, Upload, UserRound, X } from "lucide-react";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { CharacterCastMember } from "@/lib/types";
import { blankCastMember } from "./draft";
import { Counter, Field, TextArea, TextInput } from "./fields";
import styles from "./studio.module.css";

/**
 * Cast management.
 *
 * Compact cards rather than a wall of expanded forms: on a phone, five
 * simultaneously open character definitions is unusable. Tapping a member
 * opens its full definition in a sheet.
 */
export function CastEditor({ cast, onChange, onError, emptyNote, addLabel = "Add character" }: {
  cast: CharacterCastMember[];
  onChange: (cast: CharacterCastMember[]) => void;
  onError: (message: string) => void;
  emptyNote: string;
  addLabel?: string;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= cast.length) return;
    const next = [...cast];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return <div className={styles.field}>
    {cast.length === 0 && <p className={styles.emptyNote}>{emptyNote}</p>}
    {cast.length > 0 && <div className={styles.memberList}>
      {cast.map((member, index) => {
        const portrait = avatarSource(characterAvatarBucket, member.avatarPath, member.avatarUrl);
        return <article key={index} className={styles.memberCard}>
          <span className={styles.memberAvatar}>
            {portrait ? <img src={portrait} alt="" /> : (member.name.trim()[0]?.toUpperCase() ?? <UserRound size={18} aria-hidden />)}
          </span>
          <div className={styles.memberCopy}>
            <strong>{member.name.trim() || "Unnamed character"}</strong>
            <small>{member.role.trim() || member.tagline.trim() || "No role yet"}</small>
          </div>
          <div className={styles.memberActions}>
            <button type="button" className={styles.miniButton} aria-label={`Move ${member.name || "character"} up`} disabled={index === 0} onClick={() => move(index, -1)}><ChevronUp size={15} /></button>
            <button type="button" className={styles.miniButton} aria-label={`Move ${member.name || "character"} down`} disabled={index === cast.length - 1} onClick={() => move(index, 1)}><ChevronDown size={15} /></button>
            <button type="button" className={styles.miniButton} aria-label={`Edit ${member.name || "character"}`} onClick={() => setEditingIndex(index)}><Pencil size={15} /></button>
            <button
              type="button"
              className={`${styles.miniButton} ${styles.miniDanger}`}
              aria-label={`Remove ${member.name || "character"}`}
              onClick={() => onChange(cast.filter((_, position) => position !== index))}
            ><Trash2 size={15} /></button>
          </div>
        </article>;
      })}
    </div>}

    <button type="button" className={styles.addButton} disabled={cast.length >= 50} onClick={() => {
      onChange([...cast, { ...blankCastMember }]);
      setEditingIndex(cast.length);
    }}>
      {addLabel}
    </button>

    {editingIndex !== null && cast[editingIndex] && <CastMemberSheet
      member={cast[editingIndex]}
      index={editingIndex}
      onError={onError}
      onChange={(member) => onChange(cast.map((item, position) => position === editingIndex ? member : item))}
      onClose={() => setEditingIndex(null)}
    />}
  </div>;
}

function CastMemberSheet({ member, index, onChange, onClose, onError }: {
  member: CharacterCastMember;
  index: number;
  onChange: (member: CharacterCastMember) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const portrait = avatarSource(characterAvatarBucket, member.avatarPath, member.avatarUrl);
  const set = (changes: Partial<CharacterCastMember>) => onChange({ ...member, ...changes });

  return <div className={styles.sheetBackdrop} role="dialog" aria-modal="true" aria-label={`Character ${index + 1}`} onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className={styles.sheet}>
      <header className={styles.sheetHead}>
        <h3>{member.name.trim() || `Character ${index + 1}`}</h3>
        <button type="button" className={styles.iconButton} aria-label="Close character" onClick={onClose}><X size={18} /></button>
      </header>
      <div className={styles.sheetBody}>
        <div className={styles.coverRow}>
          <div className={styles.coverPreview} style={{ width: 88, height: 110 }}>
            {portrait ? <img src={portrait} alt="" /> : <UserRound size={20} aria-hidden />}
          </div>
          <div className={styles.coverActions}>
            <label className={styles.fileButton}>
              <Upload size={15} aria-hidden />{busy ? "Uploading…" : portrait ? "Replace portrait" : "Add portrait"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setBusy(true);
                try { set({ avatarPath: await uploadImage(file, characterAvatarBucket) }); }
                catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
                finally { setBusy(false); }
              }} />
            </label>
            {(member.avatarPath || member.avatarUrl) && <button type="button" className={styles.ghostButton} onClick={() => set({ avatarPath: "", avatarUrl: "" })}>Remove portrait</button>}
          </div>
        </div>

        <Field label="Name" required hint="Write the name this character is called by.">
          <TextInput value={member.name} maxLength={120} autoFocus={!member.name} onChange={(value) => set({ name: value })} placeholder="This character's name" />
        </Field>
        <Field label="Role" optional hint="Say in a few words how they relate to the story or to the reader.">
          <TextInput value={member.role} maxLength={240} onChange={(value) => set({ role: value })} placeholder="Their part in the story" />
        </Field>
        <Field label="Public blurb" optional hint="Write one line for the public cast card. Their definition below always stays private.">
          <TextInput value={member.tagline} maxLength={240} onChange={(value) => set({ tagline: value })} placeholder="One line readers see about them" />
        </Field>
        <Field
          label="Definition"
          hint="Describe how this character looks, thinks, speaks and behaves, what they want, and how they relate to the rest of the cast and to the reader."
          counter={<Counter value={member.description.length} max={8000} />}
        >
          <TextArea value={member.description} maxLength={8000} size="epic" onChange={(value) => set({ description: value })} placeholder="Write their appearance, personality, motives and relationships" />
        </Field>
      </div>
      <footer className={styles.sheetFoot}>
        <button type="button" className={styles.primaryCta} onClick={onClose}>Done</button>
      </footer>
    </div>
  </div>;
}
