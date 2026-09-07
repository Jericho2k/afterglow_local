"use client";

import { useState } from "react";
import { FileUp, Info } from "lucide-react";
import { contentModeLabels } from "@/lib/content-mode";
import { characterAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { ImportedCreation } from "@/lib/card-import";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * Importing a character card from SillyTavern, Chub, or anything that writes
 * the same formats.
 *
 * Separate from Paste Everything, and the separation is the feature. That flow
 * hands unstructured prose to a model and asks it to organise it; this one
 * reads a file whose structure is already known, so it costs nothing, takes a
 * moment, and — most importantly — changes not one word of what the creator
 * wrote. Somebody arriving with a character they have spent months on is not
 * looking for an interpretation of it.
 *
 * Two things are uploaded, in this order and for different reasons. The card
 * goes to the parser as raw bytes. The same file, unmodified, goes to storage
 * as the creation's artwork — a card is frequently the only copy of its art
 * that exists, so the original is preserved rather than re-encoded, and it
 * enters the ordinary framing system where the creator can choose its focal
 * point like any other upload.
 */

type ImportResponse = {
  creation: ImportedCreation;
  spec: "v1" | "v2" | "v3";
  notes: string[];
  suggestedContentMode: CreationDraft["contentMode"];
};

const specLabels: Record<ImportResponse["spec"], string> = {
  v1: "Character Card V1",
  v2: "Character Card V2",
  v3: "Character Card V3",
};

export function CardImport({ draft, hasWork, onImported, onError }: {
  draft: CreationDraft;
  hasWork: boolean;
  onImported: (draft: CreationDraft, notes: string[]) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ spec: ImportResponse["spec"]; notes: string[]; mode: CreationDraft["contentMode"] } | null>(null);

  async function importCard(file: File) {
    if (hasWork && !window.confirm("Replace what you have written so far with the imported card? Your current work will be lost.")) return;
    setBusy(true);
    onError("");
    setResult(null);
    try {
      const response = await fetch("/api/characters/import-card", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "That card could not be read.");
      const imported = (data as ImportResponse).creation;

      /*
       * The artwork, preserved.
       *
       * Only for a PNG, because only a PNG card carries an image; a JSON card
       * has none and the creator uploads one themselves. A failure here is
       * reported but does NOT fail the import — losing a character's text
       * because its picture could not be stored would be the wrong trade, and
       * the creator can add the image afterwards.
       */
      let avatarPath = "";
      if (/^image\/png$/i.test(file.type) || /\.png$/i.test(file.name)) {
        try { avatarPath = await uploadImage(file, characterAvatarBucket, { renderable: true }); }
        catch { onError("The card was imported, but its artwork could not be uploaded. You can add an image in the next step."); }
      }

      onImported({
        ...draft,
        name: imported.name,
        title: imported.title,
        tagline: imported.tagline,
        backstory: imported.backstory,
        personality: imported.personality,
        scenario: imported.scenario,
        greeting: imported.greeting,
        alternateGreetings: imported.alternateGreetings,
        exampleDialogue: imported.exampleDialogue,
        responseDirective: imported.responseDirective,
        tags: imported.tags,
        hashtags: imported.hashtags,
        avatarPath,
        avatarUrl: avatarPath ? "" : imported.avatarUrl,
        sourceMaterial: imported.sourceMaterial,
        lorebook: imported.lorebook,
        proposedWorld: imported.proposedWorld,
        /*
         * A suggestion, applied to a PRIVATE draft.
         *
         * Nothing here can publish: `visibility` is untouched and every draft
         * starts private, so the mode below is a starting position for the
         * creator's review rather than a decision about who may see this.
         * Imported artwork stays unreviewed for sharing for the same reason —
         * a card nobody at Afterglow has looked at is not share-safe media.
         */
        contentMode: imported.contentMode,
        shareMediaStatus: "unreviewed",
      }, imported.notes);
      setResult({ spec: (data as ImportResponse).spec, notes: imported.notes, mode: imported.contentMode });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "That card could not be read.");
    } finally { setBusy(false); }
  }

  return <div className={styles.cardImport}>
    <label className={styles.fileButton}>
      <FileUp size={15} aria-hidden />{busy ? "Reading card…" : "Choose a card file"}
      <input
        type="file"
        accept=".png,.json,image/png,application/json"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) await importCard(file);
        }}
      />
    </label>
    <small className={styles.framingNote}>
      A PNG card or a character card JSON, from SillyTavern, Chub or anywhere that exports them. Your wording is imported exactly as written — nothing is rewritten or shortened.
    </small>

    {result && <div className={styles.importNotice} role="status">
      <Info size={15} aria-hidden />
      <div>
        <strong>{specLabels[result.spec]} imported.</strong>
        <small>
          Suggested content mode: {contentModeLabels[result.mode]}. This is a guess from the card&apos;s own tags — check it before you publish. Nothing is public until you save.
        </small>
        {result.notes.length > 0 && <ul>{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </div>
    </div>}
  </div>;
}
