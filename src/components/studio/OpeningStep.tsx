"use client";

import { Plus, Trash2 } from "lucide-react";
import type { CreationType } from "@/lib/types";
import { Counter, Field, TextArea } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

const placeholders: Record<CreationType, string> = {
  character: "The rain had not stopped for three days, and neither had she.\n\n*She looks up as the door closes behind you, pen still moving across the page.* \"You're soaked.\"",
  cast: "*The kitchen light is still on at two in the morning. Maya is at the table with a mug of something long gone cold; Sophie is arguing with the toaster.*",
  scenario: "The briefing room has no windows and too many chairs.\n\n*Nezu sets a sealed file on the table between you and does not open it.* \"Before we begin, you should know that four people in this building believe you should still be in that cell.\"",
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
      <p>The first message of the roleplay. Write the scene properly — this is what sets the tone before anybody types a word.</p>
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
          placeholder={index === 0 ? placeholders[draft.creationType] : "A different way into the same story…"}
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
    <p className={styles.hint}>Readers pick which opening to start from when they begin a new chat.</p>

    <Field
      label="Example dialogue"
      optional
      hint={draft.creationType === "scenario"
        ? "Sample narration and dialogue that teach the style. {{user}} is the reader."
        : "Sample exchanges that teach cadence and formatting. {{char}} is the character, {{user}} is the reader."}
      counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
    >
      <TextArea value={draft.exampleDialogue} maxLength={12000} size="tall" onChange={(value) => update({ exampleDialogue: value })} />
    </Field>
  </>;
}
