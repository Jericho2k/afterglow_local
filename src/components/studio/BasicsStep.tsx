"use client";

import { Compass, Sparkles } from "lucide-react";
import { creationTypeLabels } from "@/lib/creation";
import type { CreationType } from "@/lib/types";
import { CoverPicker, GalleryEditor, QuickFactsEditor } from "./MediaFields";
import { CreationTypeSelector } from "./CreationTypeSelector";
import { HashtagInput } from "./HashtagInput";
import { TagSelector } from "./TagSelector";
import { Counter, Disclosure, Field, TextArea, TextInput } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * Everything that decides how the creation appears publicly.
 *
 * The title is the creation's, not necessarily a character's: "The Final War"
 * and "Your New Roommate" are both valid titles for creations whose characters
 * are named something else entirely, or not named at all.
 */
export function BasicsStep({ draft, update, onChangeType, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onChangeType: (type: CreationType) => void;
  onError: (message: string) => void;
}) {
  return <>
    <header className={styles.stepHead}>
      <h2>Basics</h2>
      <p>How your creation introduces itself in the feed and on its page.</p>
    </header>

    <Field
      label="Creation title"
      required
      hint="The name people see on the card. For a single character this is usually just their name."
      counter={<Counter value={draft.title.length} max={120} />}
    >
      <TextInput
        value={draft.title}
        maxLength={120}
        onChange={(value) => update({ title: value })}
        placeholder={draft.creationType === "scenario" ? "The Final War" : draft.creationType === "cast" ? "Roommates From Hell" : "Seraphine"}
      />
    </Field>

    <Field
      label="Tagline"
      optional
      hint="One line that makes somebody open it. Shown under the title on cards."
      counter={<Counter value={draft.tagline.length} max={300} />}
    >
      <TextInput
        value={draft.tagline}
        maxLength={300}
        onChange={(value) => update({ tagline: value })}
        placeholder="The girl who writes your name in the margins of her poetry."
      />
    </Field>

    <CoverPicker
      avatarPath={draft.avatarPath}
      avatarUrl={draft.avatarUrl}
      accent={draft.accent}
      onChange={(changes) => update(changes)}
      onError={onError}
    />

    <Field
      label="Description"
      optional
      hint="The public premise, in your own voice. This is what readers see — your AI instructions stay private."
      counter={<Counter value={draft.description.length} max={6000} />}
    >
      <TextArea
        value={draft.description}
        maxLength={6000}
        size="tall"
        onChange={(value) => update({ description: value })}
        placeholder={draft.creationType === "scenario"
          ? "You're the newest transfer student at an academy where everyone seems to know something about you that you don't…"
          : "What is this experience, and why would somebody want to be in it?"}
      />
    </Field>

    <TagSelector
      tags={draft.tags}
      onChange={(tags) => update({ tags })}
      adultMode={draft.nsfwEnabled}
      onAdultMode={(nsfwEnabled) => update({ nsfwEnabled })}
    />
    <HashtagInput hashtags={draft.hashtags} onChange={(hashtags) => update({ hashtags })} />

    <Disclosure
      icon={<Compass size={17} aria-hidden />}
      title="More public detail"
      description="Quick facts, gallery images and the accent colour."
      count={draft.quickFacts.length + draft.gallery.length}
    >
      <QuickFactsEditor facts={draft.quickFacts} onChange={(quickFacts) => update({ quickFacts })} />
      <GalleryEditor images={draft.gallery} onChange={(gallery) => update({ gallery })} onError={onError} />
      <Field label="Accent colour" optional hint="Tints the card and page for this creation.">
        <input
          type="color"
          className={styles.input}
          style={{ height: 52, padding: 6 }}
          value={draft.accent}
          aria-label="Accent colour"
          onChange={(event) => update({ accent: event.target.value })}
        />
      </Field>
    </Disclosure>

    <Disclosure
      icon={<Sparkles size={17} aria-hidden />}
      title="Change what you're making"
      description={`Currently a ${creationTypeLabels[draft.creationType].toLowerCase()}. Switching keeps everything you have written.`}
    >
      <CreationTypeSelector value={draft.creationType} onChange={onChangeType} />
    </Disclosure>
  </>;
}
