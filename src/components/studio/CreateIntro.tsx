"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardPaste, Clock3, Globe2, Info, PenLine, Sparkles, Trash2, Wand2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { Character, CreationType } from "@/lib/types";
import type { CreationAiNotice, CreationWorldDraft } from "@/lib/creation-ai";
import { CreationTypeSelector } from "./CreationTypeSelector";
import { Counter, Field, TextArea, TextInput, Toggle } from "./fields";
import { draftFromCharacter, type CreationDraft } from "./draft";
import { forgetStoredDraft, listStoredDrafts, type DraftSummary } from "./drafts";
import styles from "./studio.module.css";

/**
 * The Create screen.
 *
 * Three ways in, and they are genuinely three: describe an idea and let
 * Afterglow draft it, paste work that already exists and have it organised, or
 * open an empty studio. Above them sits whatever the creator left unfinished
 * last time, because unsaved work that nobody can find is the same as lost
 * work.
 *
 * Quick Idea and Paste Everything share this screen and share the draft they
 * produce. They do not share their controls: a generator takes a creative
 * direction, an importer takes a decision about whether its wording may be
 * touched at all. The old shared tone menu is gone, and it is not coming back
 * as a checkbox — "Dramatic" applied to somebody's imported card is an
 * instruction to rewrite it.
 */

type GenerateResponse = {
  creation: Partial<Character>;
  world: CreationWorldDraft | null;
  notices: CreationAiNotice[];
  stats: { sourceCharacters: number; organizedCharacters: number; castMembers: number; openings: number; tags: number; hashtags: number; unknownTags: string[]; worldCharacters: number; audited: boolean };
};

type Mode = "idea" | "import";

const relative = (iso: string) => {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return "recently";
  const minutes = Math.round((Date.now() - value) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
};

export function CreateIntro({ draft, update, onChangeType, onGenerated, onContinueDraft, onError, hasWork }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onChangeType: (type: CreationType) => void;
  onGenerated: (draft: CreationDraft, notices: CreationAiNotice[]) => void;
  /** Resume a stored draft, which may belong to a creation already saved. */
  onContinueDraft: (summary: DraftSummary) => void;
  onError: (message: string) => void;
  /** True when this session already holds work an accelerator would replace. */
  hasWork: boolean;
}) {
  const [mode, setMode] = useState<Mode>("idea");
  const [idea, setIdea] = useState("");
  const [direction, setDirection] = useState("");
  const [polish, setPolish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  /**
   * Whether the creator actually chose a structure, rather than the studio
   * having defaulted to one.
   *
   * This matters: the draft always carries a creation type, and "character" is
   * its default. Sending that to the model on every run would silently forbid
   * Quick Idea from ever answering with a cast or a scenario, which is most of
   * what makes it useful. A choice the creator made is an instruction; a
   * default they walked past is not.
   */
  const [typeChosen, setTypeChosen] = useState(false);

  // Read once on mount rather than on every render: the list is a snapshot of
  // what was left behind before this session started, and this session's own
  // autosave must not make a card for the thing being edited right now.
  useEffect(() => { setDrafts(listStoredDrafts()); }, []);

  const canGenerate = idea.trim().length >= 8 && !busy;
  const placeholder = mode === "import"
    ? "Paste the whole thing — the card, the definition, the lorebook, the openings, the notes. Nothing needs tidying first."
    : "One or two sentences is enough. A character, a group, or a whole situation.";

  async function generate() {
    // Nothing is destroyed without being asked. An accelerator run over
    // existing work replaces that work, so it is a decision, not a side effect.
    if (hasWork && !window.confirm("Replace what you have written so far with the generated draft? Your current work will be lost.")) return;
    setBusy(true);
    onError("");
    try {
      const data = await api<GenerateResponse>("/api/characters/generate", {
        method: "POST",
        body: JSON.stringify({
          idea,
          mode,
          direction: mode === "idea" ? direction : "",
          polish: mode === "import" ? polish : false,
          // Only a deliberate choice is sent. Left untouched, the model
          // decides the structure from the material itself.
          creationType: typeChosen ? draft.creationType : null,
          // The generator only needs to know whether explicit material is on
          // the table, which is the capability rather than the presentation.
          nsfwEnabled: draft.contentMode !== "clean",
        }),
      });
      const generated = draftFromCharacter(data.creation as Character);
      onGenerated({
        ...generated,
        // Visibility is never the model's decision.
        visibility: draft.visibility,
        proposedWorld: data.world ? { name: data.world.name, description: data.world.description } : null,
        lorebook: data.world ? data.world.content : generated.lorebook,
      }, data.notices ?? []);
    } catch (reason) {
      // The pasted source is still in the box, and the draft is untouched.
      onError(reason instanceof Error ? reason.message : "That did not work. Your text is still here — try again.");
    } finally { setBusy(false); }
  }

  return <>
    <header className={styles.stepHead}>
      <h2>What are you creating?</h2>
      <p>Pick the shape that fits. You can change it later without losing anything you have written.</p>
    </header>

    {drafts.length > 0 && <ResumeDrafts
      drafts={drafts}
      onContinue={onContinueDraft}
      onDiscard={(summary) => {
        forgetStoredDraft(summary.key);
        setDrafts((current) => current.filter((item) => item.key !== summary.key));
      }}
    />}

    <CreationTypeSelector value={draft.creationType} onChange={(type) => { setTypeChosen(true); onChangeType(type); }} />

    <section className={styles.generator}>
      <div className={styles.cardHead}>
        <Sparkles size={17} aria-hidden />
        <div>
          <strong>Start with a draft</strong>
          <small>Optional. Afterglow fills the studio in for you and you edit everything before anything is published.</small>
        </div>
      </div>

      <div className={styles.segmented} role="group" aria-label="How to start">
        <button type="button" aria-pressed={mode === "idea"} onClick={() => setMode("idea")}>
          <Wand2 size={14} aria-hidden />Quick idea
        </button>
        <button type="button" aria-pressed={mode === "import"} onClick={() => setMode("import")}>
          <ClipboardPaste size={14} aria-hidden />Paste everything
        </button>
      </div>

      <p className={styles.modeNote}>
        {mode === "import"
          ? "Import keeps your writing as it is. It works out the structure, separates world material from character material, finds your openings and example dialogue, and files everything where it belongs."
          : "Quick idea invents the rest. Give it a concept and it writes a first draft you can rework."}
      </p>

      <Field
        label={mode === "import" ? "Your material" : "Your idea"}
        hint={mode === "import"
          ? "Paste anything: a character card, a scenario, several characters, a lorebook, a long prompt, JSON. The original is kept on the creation for you to look at later."
          : "Describe what you want to exist. Afterglow works out whether it is a character, a cast or a scenario."}
        counter={<Counter value={idea.length} max={100000} />}
      >
        <TextArea
          value={idea}
          maxLength={100000}
          size={mode === "import" ? "epic" : "normal"}
          onChange={setIdea}
          placeholder={placeholder}
        />
      </Field>

      {mode === "idea"
        ? <Field
            label="Creative direction"
            optional
            hint="Add any tone, pacing, dynamic or stylistic constraints you want the generator to follow. Leave it blank and Afterglow reads an appropriate direction from the idea itself."
          >
            <TextInput
              value={direction}
              maxLength={600}
              onChange={setDirection}
              placeholder="Slow burn, dry humour, no melodrama"
            />
          </Field>
        : <Toggle
            label="Lightly polish wording"
            description="Off keeps your writing exactly as you wrote it. On fixes grammar, spacing and broken formatting only — never the tone, the characterisation, the explicitness or any fact."
            checked={polish}
            onChange={setPolish}
          />}

      <div className={styles.generatorFoot}>
        <button type="button" className={styles.magicButton} disabled={!canGenerate} onClick={() => void generate()}>
          <Sparkles size={16} aria-hidden />
          {busy
            ? (mode === "import" ? "Reading and organising…" : "Drafting…")
            : (mode === "import" ? "Import and organise" : "Draft it for me")}
        </button>
      </div>
      {busy && <p className={styles.hint} role="status">
        {mode === "import"
          ? "Your text stays exactly where it is while this runs. Long material takes longer because it is being read in full rather than summarised."
          : "Writing a first draft. You will land in the studio with everything editable."}
      </p>}
    </section>

    <Field
      label="Or name it and start writing"
      optional
      hint="Skip the accelerators entirely. You can name the creation now or on the next step."
    >
      <TextInput
        value={draft.title}
        maxLength={120}
        onChange={(value) => update({ title: value })}
        placeholder={draft.creationType === "scenario" ? "What the experience is called" : draft.creationType === "cast" ? "What this group is called" : "What this character is called"}
      />
    </Field>
  </>;
}

/**
 * Unfinished work, offered back.
 *
 * Only sessions that actually held content appear: the meaningfulness rule the
 * studio autosaves by is applied again when the list is read, so opening
 * Create and leaving still produces nothing here. A draft belonging to a
 * creation that has already been saved says so, because continuing it means
 * resuming unsaved edits rather than starting something new.
 */
function ResumeDrafts({ drafts, onContinue, onDiscard }: {
  drafts: DraftSummary[];
  onContinue: (summary: DraftSummary) => void;
  onDiscard: (summary: DraftSummary) => void;
}) {
  return <section className={styles.resume} aria-label="Continue where you left off">
    <div className={styles.cardHead}>
      <Clock3 size={17} aria-hidden />
      <div>
        <strong>Continue where you left off</strong>
        <small>{drafts.length === 1 ? "One unfinished draft on this device." : `${drafts.length} unfinished drafts on this device.`}</small>
      </div>
    </div>
    <div className={styles.resumeList}>
      {drafts.map((summary) => <DraftCard key={summary.key} summary={summary} onContinue={onContinue} onDiscard={onDiscard} />)}
    </div>
  </section>;
}

function DraftCard({ summary, onContinue, onDiscard }: {
  summary: DraftSummary;
  onContinue: (summary: DraftSummary) => void;
  onDiscard: (summary: DraftSummary) => void;
}) {
  const cover = useMemo(
    () => avatarSource(characterAvatarBucket, summary.draft.avatarPath, summary.draft.avatarUrl),
    [summary.draft.avatarPath, summary.draft.avatarUrl],
  );
  return <article className={styles.draftCard}>
    <span className={styles.draftArt} style={{ "--accent": summary.draft.accent } as React.CSSProperties}>
      {cover ? <img src={cover} alt="" /> : <PenLine size={17} aria-hidden />}
    </span>
    <div className={styles.draftCopy}>
      <strong>{summary.label}</strong>
      <small>
        {summary.typeLabel}
        <span aria-hidden> · </span>
        {/* Unsaved edits to a creation that exists are a different thing from
            something that was never saved, and the card says which. */}
        {summary.creationId ? "Unsaved changes" : "Not saved yet"}
      </small>
      <small>Edited {relative(summary.savedAt)}</small>
    </div>
    <div className={styles.draftActions}>
      <button type="button" className={styles.draftContinue} onClick={() => onContinue(summary)}>Continue</button>
      <button
        type="button"
        className={`${styles.miniButton} ${styles.miniDanger}`}
        aria-label={`Discard the draft of ${summary.label}`}
        onClick={() => { if (window.confirm(`Discard your unfinished draft of “${summary.label}”? This cannot be undone.`)) onDiscard(summary); }}
      ><Trash2 size={15} /></button>
    </div>
  </article>;
}

/**
 * What the accelerator did, and what it decided not to do.
 *
 * Every one of these is a suggestion the creator may change: a tag it dropped,
 * a world it proposed, adult mode it switched on. The one that is not a
 * suggestion is an age contradiction, which is why it is styled as a warning
 * and says plainly that nothing in the creator's text was rewritten.
 */
export function AiNotices({ notices, onDismiss }: { notices: CreationAiNotice[]; onDismiss: () => void }) {
  if (!notices.length) return null;
  return <div className={styles.noticeStack}>
    {notices.map((notice, index) => {
      const warning = notice.kind === "age_conflict";
      const Icon = warning ? AlertTriangle : notice.kind === "world" ? Globe2 : Info;
      return <div key={index} className={warning ? styles.warningNotice : styles.notice} role={warning ? "alert" : "status"}>
        <Icon size={15} className={styles.noticeIcon} aria-hidden />
        <span>{notice.message}</span>
        {index === notices.length - 1 && <button type="button" onClick={onDismiss}>Dismiss</button>}
      </div>;
    })}
  </div>;
}
