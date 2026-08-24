"use client";

import { Plus, Trash2 } from "lucide-react";
import type { CreationType } from "@/lib/types";
import type { RichBlock } from "@/lib/rich-content";
import { RichEditor } from "@/components/rich";
import { characterAvatarBucket } from "@/lib/storage";
import { Counter, Field, TextArea } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/*
 * Guidance, not sample fiction.
 *
 * A creator staring at somebody else's paragraph tends to either copy it or
 * write around it. What they need to know is what this box is for and what
 * shape the writing takes, so each placeholder says that in the terms of the
 * structure they are actually authoring.
 */
const placeholders: Record<CreationType, string> = {
  character: "Write the scene readers open on: where they are, what the character is doing, and the first thing said. Action in *italics*, speech in quotes.",
  cast: "Write the scene readers open on, with the cast already in it and doing something. Action in *italics*, speech in quotes.",
  scenario: "Write the scene readers open on: the setting, what is happening, and what is put in front of them. Action in *italics*, speech in quotes.",
};

/**
 * Openings.
 *
 * These are roleplay scenes, not chat greetings — several paragraphs of scene,
 * dialogue and atmosphere is normal, so the editor is sized for prose. The
 * first opening is the default and every new chat may choose any of them,
 * which is the behaviour the chat side already supports.
 */
export function OpeningStep({ draft, update, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onError: (message: string) => void;
}) {
  const openings = [draft.greeting, ...draft.alternateGreetings];
  const openingBlocks = [draft.greetingRich, ...draft.alternateGreetings.map((_, index) => draft.alternateGreetingsRich[index] ?? [])];

  /**
   * Both halves of an opening move together.
   *
   * The text is what the roleplay receives and the blocks are what the reader
   * sees, so they are written from one place and can never describe different
   * scenes.
   */
  function setOpening(index: number, value: { blocks: RichBlock[]; text: string }) {
    if (index === 0) { update({ greeting: value.text, greetingRich: value.blocks }); return; }
    const position = index - 1;
    update({
      alternateGreetings: draft.alternateGreetings.map((opening, item) => item === position ? value.text : opening),
      alternateGreetingsRich: draft.alternateGreetings.map((_, item) =>
        item === position ? value.blocks : draft.alternateGreetingsRich[item] ?? []),
    });
  }

  function removeOpening(position: number) {
    update({
      alternateGreetings: draft.alternateGreetings.filter((_, item) => item !== position),
      alternateGreetingsRich: draft.alternateGreetings
        .map((_, item) => draft.alternateGreetingsRich[item] ?? [])
        .filter((_, item) => item !== position),
    });
  }

  return <>
    <header className={styles.stepHead}>
      <h2>Opening</h2>
      <p>Write the scene readers see when they begin a new chat. This sets the tone before anybody types a word, so write it properly rather than as a greeting. You can place images between paragraphs — readers see them, the AI does not.</p>
    </header>

    <div className={styles.field}>
      {openings.map((opening, index) => <article key={index} className={styles.openingCard}>
        <div className={styles.openingHead}>
          <span className={styles.openingIndex}>{index + 1}</span>
          <strong>{index === 0 ? "Opening" : `Alternative ${index}`}</strong>
          {index === 0 ? <em>default</em> : null}
          {index > 0 && <button
            type="button"
            className={`${styles.miniButton} ${styles.miniDanger}`}
            aria-label={`Remove alternative ${index}`}
            onClick={() => removeOpening(index - 1)}
          ><Trash2 size={15} /></button>}
        </div>
        <RichEditor
          blocks={openingBlocks[index] ?? []}
          text={opening}
          bucket={characterAvatarBucket}
          size={index === 0 ? "epic" : "tall"}
          onError={onError}
          onChange={(value) => setOpening(index, value)}
          placeholder={index === 0 ? placeholders[draft.creationType] : "Write a different way into the same story"}
        />
        <div className={styles.fieldFoot}><Counter value={opening.length} max={8000} /></div>
      </article>)}
    </div>

    <button
      type="button"
      className={styles.addButton}
      disabled={draft.alternateGreetings.length >= 11}
      onClick={() => update({ alternateGreetings: [...draft.alternateGreetings, ""], alternateGreetingsRich: [...draft.alternateGreetings.map((_, item) => draft.alternateGreetingsRich[item] ?? []), []] })}
    >
      <Plus size={16} aria-hidden />Add another opening
    </button>
    <p className={styles.hint}>Readers choose which opening to start from when they begin a new chat. Add one only when it is genuinely a different way in.</p>

    <Field
      label="Example dialogue"
      optional
      hint={draft.creationType === "scenario"
        ? "Write narration and dialogue that demonstrate the style you want. {{user}} refers to the reader."
        : "Write dialogue that demonstrates the voice, formatting and conversational style you want. {{char}} is the character, {{user}} is the reader."}
      counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
    >
      <TextArea
        value={draft.exampleDialogue}
        maxLength={12000}
        size="tall"
        onChange={(value) => update({ exampleDialogue: value })}
        placeholder={draft.creationType === "scenario" ? "Write a short passage in the voice the narration should use" : "{{char}}: …\n{{user}}: …"}
      />
    </Field>
  </>;
}
