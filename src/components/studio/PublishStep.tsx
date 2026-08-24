"use client";

import { Eye, Link2, Lock, Trash2 } from "lucide-react";
import { creationTitle, creationTypeLabels } from "@/lib/creation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { CharacterVisibility } from "@/lib/types";
import { ChoiceList, SectionCard, Toggle } from "./fields";
import type { CreationDraft, DraftProblem } from "./draft";
import styles from "./studio.module.css";

/**
 * Visibility, content settings and the publish decision.
 *
 * Visibility is the existing product control and is preserved exactly:
 * private, unlisted and public behave as they always have, and chats,
 * memories and stories stay private in every case.
 */
export function PublishStep({ draft, update, problems, onGoToStep, onDelete, existing }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  problems: DraftProblem[];
  onGoToStep: (step: string) => void;
  onDelete?: () => void;
  existing: boolean;
}) {
  const cover = avatarSource(characterAvatarBucket, draft.avatarPath, draft.avatarUrl);
  const title = creationTitle({ title: draft.title, name: draft.name, creationType: draft.creationType, profileType: draft.profileType });

  return <>
    <header className={styles.stepHead}>
      <h2>{existing ? "Settings" : "Publish"}</h2>
      <p>Who can find this, and how it behaves once it is out there.</p>
    </header>

    <div className={styles.preview}>
      <div className={styles.previewArt} style={{ "--accent": draft.accent } as React.CSSProperties}>
        {cover ? <img src={cover} alt="" /> : title.trim()[0]?.toUpperCase() || "?"}
      </div>
      <div className={styles.previewCopy}>
        <span className={styles.previewKind}>{creationTypeLabels[draft.creationType]}</span>
        <strong>{title}</strong>
        {draft.tagline && <p>{draft.tagline}</p>}
        <div className={styles.previewMeta}>
          <span>{draft.tags.length} tags</span>
          <span>{draft.hashtags.length} hashtags</span>
          <span>{[draft.greeting, ...draft.alternateGreetings].filter(Boolean).length} openings</span>
          {draft.worldIds.length > 0 && <span>{draft.worldIds.length} world{draft.worldIds.length === 1 ? "" : "s"}</span>}
          {draft.cast.length > 0 && <span>{draft.cast.length} characters</span>}
        </div>
      </div>
    </div>

    {problems.length > 0 && <div className={styles.error}>
      <strong>Before publishing, a couple of things need attention:</strong>
      <ul className={styles.errorList}>
        {problems.map((problem, index) => <li key={index}>
          <button type="button" onClick={() => onGoToStep(problem.step)}>{problem.message}</button>
        </li>)}
      </ul>
    </div>}

    <SectionCard title="Who can see this" description="Choose who can reach the creation. Your chats, memories and stories stay private whichever you pick — publishing shares the creation itself, never your play.">
      <ChoiceList<CharacterVisibility>
        label="Visibility"
        value={draft.visibility}
        onChange={(visibility) => update({ visibility })}
        options={[
          { value: "private", label: "Private", description: "Only you. Nothing appears in the feed." },
          { value: "unlisted", label: "Unlisted", description: "Anyone with the link, but never listed for browsing." },
          { value: "public", label: "Public", description: "Listed in the feed and discoverable by everybody." },
        ]}
      />
    </SectionCard>

    <SectionCard title="Content" description="Set whether this is adult work. It decides the badge on the card and the rules the roleplay follows.">
      <Toggle
        label="Adult mode · 18+"
        description="Allows consensual explicit roleplay between fictional adults, and marks the card 18+. Readers see it only when they have opted into 18+ content."
        checked={draft.nsfwEnabled}
        onChange={(nsfwEnabled) => update({ nsfwEnabled })}
      />
    </SectionCard>

    <p className={styles.hint}>
      {draft.visibility === "public"
        ? <><Eye size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> Public creations appear in Home for everyone. You can set it back to private at any time.</>
        : draft.visibility === "unlisted"
          ? <><Link2 size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> Unlisted creations are reachable only by their link.</>
          : <><Lock size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> Private creations are yours alone — a good place to keep a draft while you work on it.</>}
    </p>

    {onDelete && <button type="button" className={styles.dangerButton} onClick={onDelete}>
      <Trash2 size={15} aria-hidden />Delete this creation
    </button>}
  </>;
}
