"use client";

import { useState } from "react";
import type { ChatInstructionPreset, Conversation } from "@/lib/types";
import { activeInstructionCount, hasCustomInstruction, instructionChoices } from "@/lib/chat-instructions";
import { uiStyles } from "@/components/ui";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * Chat instructions.
 *
 * Two things were wrong here and only one of them was visible.
 *
 * The visible one: with two presets selected and custom text written, the
 * control still read "2". It was not a stale render — the composer's own
 * counter simply never counted custom text at all, while the strip above it
 * did, so the same conversation reported two different numbers depending on
 * which label you looked at. Both now read `activeInstructionCount`, which is
 * defined as exactly what the writer receives.
 *
 * The invisible one: custom text was an active requirement with no control of
 * its own. It applied, it counted (in one place), and there was nothing in the
 * list of instructions saying it existed. So Custom is now a choice beside the
 * presets: turning it on reveals the field, non-empty text makes it active,
 * and turning it off clears the stored instruction rather than leaving one
 * quietly in force.
 *
 * The draft is kept while the sheet is open, so toggling Custom off to see the
 * count change and back on again does not cost the creator their paragraph;
 * only Save decides what is stored.
 */
export function InstructionsSheet({ conversation, onClose, onSave }: {
  conversation: Conversation;
  onClose: () => void;
  onSave: (value: { instructionPresets: ChatInstructionPreset[]; customInstructions: string }) => Promise<void>;
}) {
  const [presets, setPresets] = useState<ChatInstructionPreset[]>(conversation.instructionPresets);
  const [custom, setCustom] = useState(conversation.customInstructions);
  // Custom starts on when the conversation already has text, because that is
  // what "on" means: this conversation carries a custom requirement.
  const [customOn, setCustomOn] = useState(hasCustomInstruction(conversation.customInstructions));
  const [busy, setBusy] = useState(false);

  // What would be stored if Save were pressed now — which is also what the
  // count must reflect, immediately, without closing anything.
  const pending = {
    instructionPresets: presets,
    customInstructions: customOn ? custom : "",
  };
  const count = activeInstructionCount(pending);

  function togglePreset(id: ChatInstructionPreset, on: boolean) {
    setPresets(on ? [...presets, id] : presets.filter((item) => item !== id));
  }

  return <Sheet
    eyebrow="This story only"
    title="Instructions"
    onClose={onClose}
    footer={<>
      <span className={styles.quiet} style={{ alignSelf: "center" }}>
        {count === 0 ? "No instructions active" : `${count} active`}
      </span>
      <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={onClose}>Cancel</button>
      <button
        className={`${uiStyles.button} ${uiStyles.primary}`}
        disabled={busy}
        onClick={async () => { setBusy(true); await onSave(pending); setBusy(false); }}
      >{busy ? "Saving…" : "Save"}</button>
    </>}
  >
    <p className={styles.fieldHint}>
      Added beneath the character, world, persona and continuity context for this story. They apply together, and they never change what has already happened.
    </p>

    <div className={styles.stack}>
      {instructionChoices.map((choice) => {
        const on = presets.includes(choice.id);
        return <label key={choice.id} className={styles.toggleRow} data-active={on}>
          <span>
            <strong>{choice.title}</strong>
            <small>{choice.description}</small>
          </span>
          <input type="checkbox" checked={on} onChange={(event) => togglePreset(choice.id, event.target.checked)} />
        </label>;
      })}

      {/* Custom sits in the same list as the presets because it is the same
          kind of thing: one more active requirement for this story. */}
      <label className={styles.toggleRow} data-active={customOn}>
        <span>
          <strong>Custom</strong>
          <small>Your own instruction, in your own words. Counts as active only while it says something.</small>
        </span>
        <input type="checkbox" checked={customOn} onChange={(event) => setCustomOn(event.target.checked)} />
      </label>

      {customOn && <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="custom-instruction">Custom instruction</label>
        <textarea
          id="custom-instruction"
          className={styles.textarea}
          rows={6}
          maxLength={3000}
          value={custom}
          autoFocus={!hasCustomInstruction(conversation.customInstructions)}
          placeholder="For example: keep replies tight during dialogue, and never describe the weather."
          onChange={(event) => setCustom(event.target.value)}
        />
        <span className={styles.counter}>{custom.length.toLocaleString()} / 3,000</span>
        {!hasCustomInstruction(custom) && <span className={styles.fieldHint}>
          Empty for now, so Custom is not counted as active yet.
        </span>}
      </div>}

      {!customOn && hasCustomInstruction(conversation.customInstructions) && <p className={styles.fieldHint}>
        Saving now clears the custom instruction this story is currently using. Turn Custom back on to keep it.
      </p>}
    </div>
  </Sheet>;
}
