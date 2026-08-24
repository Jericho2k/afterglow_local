"use client";

import { Plus, Trash2 } from "lucide-react";
import type { CreationType } from "@/lib/types";
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
export function OpeningStep({ draft, update }: { draft: CreationDraft; update: (changes: Partial<CreationDraft>) => void }) {
  const openings = [draft.greeting, ...draft.alternateGreetings];

  function setOpening(index: number, value: string) {
    if (index === 0) { update({ greeting: value }); return; }
    update({ alternateGreetings: draft.alternateGreetings.map((opening, position) => position === index - 1 ? value : opening) });
  }

  return <>
    <header className={styles.stepHead}>
      <h2>Opening</h2>
      <p>Write the scene readers see when they begin a new chat. This sets the tone before anybody types a word, so write it properly rather than as a greeting.</p>
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
            onClick={() => update({ alternateGreetings: draft.alternateGreetings.filter((_, position) => position !== index - 1) })}
          ><Trash2 size={15} /></button>}
        </div>
        <TextArea
          value={opening}
          maxLength={8000}
          size={index === 0 ? "epic" : "tall"}
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
      onClick={() => update({ alternateGreetings: [...draft.alternateGreetings, ""] })}
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
