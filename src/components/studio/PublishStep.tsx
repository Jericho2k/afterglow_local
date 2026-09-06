"use client";

import { Eye, Link2, Lock, Trash2 } from "lucide-react";
import { creationTitle, creationTypeLabels } from "@/lib/creation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { CharacterVisibility } from "@/lib/types";
import { contentModeDescriptions, contentModeLabels, contentModes, publicVisibilityNotice } from "@/lib/content-mode";
import { ShareImageField } from "./MediaFields";
import { ChoiceList, Field, SectionCard, TextInput } from "./fields";
import type { CreationDraft, DraftProblem } from "./draft";
import styles from "./studio.module.css";

/**
 * Visibility, content settings and the publish decision.
 *
 * Visibility is the existing product control and is preserved exactly:
 * private, unlisted and public behave as they always have, and chats,
 * memories and stories stay private in every case.
 */
export function PublishStep({ draft, update, problems, onGoToStep, onDelete, onError, existing }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  problems: DraftProblem[];
  onGoToStep: (step: string) => void;
  onDelete?: () => void;
  onError: (message: string) => void;
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

    {/*
      * Three choices where there used to be a switch.
      *
      * The switch asked one question and answered two: turning it on both let
      * the roleplay go explicit AND marked the creation 18+, which put every
      * story that merely COULD become explicit behind the same wall as one
      * that exists to be. Most creations are the middle case, and the middle
      * case is the one that was being hidden.
      *
      * The copy for each option says what will actually happen to the work,
      * because that is what the creator is deciding.
      */}
    <SectionCard title="Content" description="What kind of story is this? It decides how the roleplay behaves and who can read the page.">
      <ChoiceList
        label="Content mode"
        value={draft.contentMode}
        onChange={(contentMode) => update({ contentMode })}
        options={contentModes.map((mode) => ({
          value: mode,
          label: contentModeLabels[mode],
          description: contentModeDescriptions[mode],
        }))}
      />
      {draft.visibility === "public" && <p className={styles.hint}>
        {publicVisibilityNotice(draft.contentMode)}
      </p>}
    </SectionCard>

    {/*
      * The outward-facing half, shown only where it can matter.
      *
      * A private or unlisted creation is never previewed anywhere, so asking
      * its author to write copy for a search result would be asking them to
      * fill in a field with no consequence.
      */}
    {draft.visibility === "public" && <SectionCard
      title="How this looks when it is shared"
      description="What people see in a search result, a link preview, or — for 18+ work — the page they land on before signing in. Written separately from the page's own title and tagline, which are for readers who have already chosen this."
    >
      <Field label="Share title" optional hint={draft.contentMode === "adult_focused"
        ? "Required for your name to appear outside Afterglow at all. Without one, shared links read “18+ creation by @you”."
        : "Defaults to the title above when you leave it empty."}>
        <TextInput value={draft.shareTitle ?? ""} onChange={(shareTitle) => update({ shareTitle })} maxLength={100} placeholder={title} />
      </Field>
      <Field label="Share description" optional hint="One line, safe for anywhere a link can be pasted.">
        <TextInput value={draft.shareTagline ?? ""} onChange={(shareTagline) => update({ shareTagline })} maxLength={200} placeholder="A line that works on somebody's work machine" />
      </Field>
      {/*
        * Nomination, which is the creator's half of the media rule.
        *
        * This section used to state the rule and offer nothing to act on: it
        * said preview images were reviewed, while the creator had no way to say
        * WHICH image was being put forward. The control below is that missing
        * half, and it deliberately changes nothing about classification —
        * choosing a different image sends it back to unreviewed, which the
        * server enforces in the same statement that stores the change.
        */}
      <ShareImageField draft={draft} update={update} onError={onError} />
    </SectionCard>}

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
