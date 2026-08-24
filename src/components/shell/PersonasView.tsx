"use client";

import { useState } from "react";
import { Plus, Trash2, UserRound } from "lucide-react";
import type { Persona } from "@/lib/types";
import { api } from "@/lib/api-client";
import { avatarSource, profileAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { compactMessagePreview } from "@/lib/message-format";
import { uiStyles } from "@/components/ui";
import { PageHeader } from "./PageHeader";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * Personas.
 *
 * A persona is who the USER plays, which is the distinction the old surface
 * kept blurring by dressing personas in the same document rows as creations.
 * They are people, so they get portraits and a page that says plainly what
 * they are for.
 *
 * The fields are exactly the ones the API already stores — name, description,
 * avatar, accent, default — and no more. A persona editor that invents fields
 * the roleplay never reads would be a worse editor, not a richer one.
 */

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

type Draft = {
  name: string; description: string; avatarUrl: string; avatarPath: string;
  accent: string; isDefault: boolean;
};

const blankDraft = (isFirst: boolean): Draft => ({
  name: "", description: "", avatarUrl: "", avatarPath: "", accent: "#e879a9", isDefault: isFirst,
});

export function PersonasView({ personas, onChange, onOpenMenu }: {
  personas: Persona[];
  onChange: () => void;
  onOpenMenu?: () => void;
}) {
  const [editing, setEditing] = useState<Persona | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft(true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function open(persona?: Persona) {
    setEditing(persona ?? "new");
    setDraft(persona
      ? { name: persona.name, description: persona.description, avatarUrl: persona.avatarUrl, avatarPath: persona.avatarPath, accent: persona.accent, isDefault: persona.isDefault }
      : blankDraft(personas.length === 0));
    setError("");
  }

  async function save() {
    setBusy(true); setError("");
    try {
      await api(editing === "new" ? "/api/personas" : `/api/personas/${(editing as Persona).id}`, {
        method: editing === "new" ? "POST" : "PATCH",
        body: JSON.stringify(draft),
      });
      setEditing(null);
      onChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this persona");
    } finally { setBusy(false); }
  }

  async function remove(persona: Persona) {
    if (!window.confirm(`Delete the persona “${persona.name}”?\n\nExisting chats fall back to your default persona. Their messages and continuity are untouched.`)) return;
    setBusy(true);
    try {
      await api(`/api/personas/${persona.id}`, { method: "DELETE" });
      setEditing(null);
      onChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete this persona");
    } finally { setBusy(false); }
  }

  const preview = avatarSource(profileAvatarBucket, draft.avatarPath, draft.avatarUrl);

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Who you play as"
        title="Personas"
        lede="Different identities, appearances and histories for yourself. Each story can use a different one, and switching never resets continuity."
        onOpenMenu={onOpenMenu}
        actions={<button className={`${uiStyles.button} ${uiStyles.primary}`} onClick={() => open()}>
          <Plus size={16} aria-hidden />New persona
        </button>}
      />

      {personas.length === 0 && <div className={styles.empty}>
        <UserRound size={26} aria-hidden />
        <h2>No personas yet</h2>
        <p>Your first persona is who characters will see, speak to and remember. Give them a name and as much or as little history as you like.</p>
        <button className={`${uiStyles.button} ${uiStyles.primary}`} onClick={() => open()}>
          <Plus size={16} aria-hidden />Create a persona
        </button>
      </div>}

      <div className={styles.grid}>
        {personas.map((persona) => {
          const source = avatarSource(profileAvatarBucket, persona.avatarPath, persona.avatarUrl);
          return <button key={persona.id} className={styles.personaCard} onClick={() => open(persona)}>
            <span className={styles.avatar} style={{ borderColor: persona.accent }} aria-hidden>
              {source ? <img src={source} alt="" /> : initials(persona.name)}
            </span>
            <span className={styles.personaBody}>
              <strong>{persona.name}</strong>
              {persona.isDefault
                ? <span className={styles.defaultBadge}>Default</span>
                : <small>Available for any story</small>}
              <p>{compactMessagePreview(persona.description || "No profile details yet.", 140)}</p>
            </span>
          </button>;
        })}
      </div>

      {editing && <Sheet
        eyebrow="Persona"
        title={editing === "new" ? "Who are you in this story?" : `Edit ${editing.name}`}
        onClose={() => setEditing(null)}
        footer={<>
          {editing !== "new" && <button
            className={`${uiStyles.button} ${uiStyles.destructive}`}
            disabled={busy || editing.isDefault}
            title={editing.isDefault ? "Choose another default persona first" : "Delete this persona"}
            onClick={() => void remove(editing)}
          ><Trash2 size={15} aria-hidden />Delete</button>}
          <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => setEditing(null)}>Cancel</button>
          <button className={`${uiStyles.button} ${uiStyles.primary}`} disabled={busy || !draft.name.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save persona"}
          </button>
        </>}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className={`${styles.avatar} ${styles.avatarLarge}`} style={{ borderColor: draft.accent }} aria-hidden>
            {preview ? <img src={preview} alt="" /> : initials(draft.name)}
          </span>
          <div style={{ display: "grid", gap: 8 }}>
            <label className={`${uiStyles.button} ${uiStyles.secondary}`} style={{ cursor: "pointer" }}>
              Choose image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: "none" }}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  try {
                    const path = await uploadImage(file, profileAvatarBucket);
                    // Only the stored path is kept: an uploaded portrait
                    // replaces an imported URL rather than shadowing it.
                    setDraft((current) => ({ ...current, avatarPath: path, avatarUrl: "" }));
                  }
                  catch (reason) { setError(reason instanceof Error ? reason.message : "Image upload failed"); }
                }}
              />
            </label>
            <label className={styles.fieldHint} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Accent
              <input type="color" aria-label="Persona accent colour" value={draft.accent} onChange={(event) => setDraft({ ...draft, accent: event.target.value })} style={{ width: 36, height: 28, border: 0, background: "none", padding: 0 }} />
            </label>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="persona-name">Name</label>
          <input id="persona-name" className={styles.input} value={draft.name} maxLength={100} placeholder="The name characters will use" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="persona-description">Profile</label>
          <textarea
            id="persona-description"
            className={styles.textarea}
            rows={9}
            maxLength={6000}
            value={draft.description}
            placeholder="Appearance, pronouns, age, personality, abilities, history, relationships, and anything characters should know…"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
          <span className={styles.counter}>{draft.description.length.toLocaleString()} / 6,000</span>
        </div>

        <label className={styles.toggleRow}>
          <span>
            <strong>Default persona</strong>
            <small>Chosen automatically when you start a new story.</small>
          </span>
          <input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />
        </label>

        {error && <p className={styles.error}>{error}</p>}
      </Sheet>}
    </div>
  </section>;
}
