"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import { api } from "@/lib/api-client";
import { memoryFeedbackCategories } from "@/lib/schemas";
import { uiStyles } from "@/components/ui";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * "She got this wrong."
 *
 * Deliberately plain language. The person tapping this is in the middle of a
 * story, not filing a bug report, so the options are what a reader would
 * actually say — and each one maps to exactly one category in the failure
 * taxonomy the evaluation harness uses.
 *
 * This is the only ground truth in the whole memory programme that comes from
 * somebody who genuinely knows the answer. The fixtures test situations we
 * invented and the replay judge is a model grading a model; this is the reader
 * saying the character broke their story, attached to the retrieval run that
 * produced it.
 */

const options: Array<{ id: typeof memoryFeedbackCategories[number]; label: string; hint: string }> = [
  { id: "forgot_something", label: "She forgot something", hint: "Something we established never came up, or was treated as new." },
  { id: "contradicted_itself", label: "It contradicted itself", hint: "Two things that cannot both be true." },
  { id: "brought_back_finished", label: "It brought back something finished", hint: "A promise already kept, or a thread already closed." },
  { id: "wrong_place_or_time", label: "Wrong place or time", hint: "It behaved as if we were somewhere else, or on another day." },
  { id: "confused_who_is_present", label: "Confused who was there", hint: "Somebody spoke or acted who is not in the scene." },
  { id: "other", label: "Something else", hint: "Tell us in your own words." },
];

export function MemoryFeedback({ messageId, conversationId, onDone }: {
  messageId: string;
  conversationId: string;
  onDone?: (category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<typeof options[number]["id"] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!category) return;
    setBusy(true); setError("");
    try {
      await api("/api/memory-feedback", {
        method: "POST",
        body: JSON.stringify({ messageId, conversationId, category, note }),
      });
      setSent(true);
      setOpen(false);
      onDone?.(category);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send that");
    } finally { setBusy(false); }
  }

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={sent ? "Thanks — noted" : "Report a continuity problem with this reply"}
      aria-label={sent ? "Continuity problem reported" : "Report a continuity problem with this reply"}
    >
      <Flag size={12} aria-hidden />{sent ? " Noted" : " Wrong?"}
    </button>

    {open && <Sheet
      eyebrow="This reply"
      title="What went wrong?"
      onClose={() => setOpen(false)}
      footer={<>
        <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => setOpen(false)}>Cancel</button>
        <button className={`${uiStyles.button} ${uiStyles.primary}`} disabled={busy || !category} onClick={() => void submit()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </>}
    >
      <p className={styles.fieldHint}>
        This helps the character remember better. We record which reply you flagged and what the memory system had retrieved for it — never the words of your story.
      </p>

      <div className={styles.stack}>
        {options.map((option) => <label key={option.id} className={styles.toggleRow} data-active={category === option.id}>
          <span>
            <strong>{option.label}</strong>
            <small>{option.hint}</small>
          </span>
          <input
            type="radio"
            name="memory-feedback"
            checked={category === option.id}
            onChange={() => setCategory(option.id)}
          />
        </label>)}

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="feedback-note">Anything else? (optional)</label>
          <textarea
            id="feedback-note"
            className={styles.textarea}
            rows={3}
            maxLength={2000}
            value={note}
            placeholder="What should she have remembered?"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </Sheet>}
  </>;
}
