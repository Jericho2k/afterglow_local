"use client";

import { Compass, Sparkles } from "lucide-react";
import { creationTypeLabels } from "@/lib/creation";
import type { CreationType } from "@/lib/types";
import { CoverPicker, GalleryEditor, QuickFactsEditor } from "./MediaFields";
import { CreationTypeSelector } from "./CreationTypeSelector";
import { HashtagInput } from "./HashtagInput";
import { TagSelector } from "./TagSelector";
import { accentVariables, defaultAccent } from "@/lib/accent";
import { RichEditor } from "@/components/rich";
import { characterAvatarBucket } from "@/lib/storage";
import { Counter, Disclosure, Field, TextInput } from "./fields";
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
      hint="Name the creation as readers will see it on its card and page. For one character this is usually their name; for a cast or a scenario, name the experience."
      counter={<Counter value={draft.title.length} max={120} />}
    >
      <TextInput
        value={draft.title}
        maxLength={120}
        onChange={(value) => update({ title: value })}
        placeholder={draft.creationType === "scenario" ? "What this experience is called" : draft.creationType === "cast" ? "What this group is called" : "What this character is called"}
      />
    </Field>

    <Field
      label="Tagline"
      optional
      hint="Write one line that makes somebody want to open this. It appears under the title on every card."
      counter={<Counter value={draft.tagline.length} max={300} />}
    >
      <TextInput
        value={draft.tagline}
        maxLength={300}
        onChange={(value) => update({ tagline: value })}
        placeholder="One line — the hook, not a summary"
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
      hint="Tell readers what this experience is and why they would want to be in it. This is the only long text shown publicly; your AI instructions stay private. You can place images between paragraphs — they are shown to readers and never sent to the AI."
      counter={<Counter value={draft.description.length} max={6000} />}
    >
      <RichEditor
        blocks={draft.descriptionRich}
        text={draft.description}
        bucket={characterAvatarBucket}
        onError={onError}
        onChange={({ blocks, text }) => update({ descriptionRich: blocks, description: text })}
        placeholder={draft.creationType === "scenario"
          ? "Describe the situation a reader is stepping into"
          : draft.creationType === "cast"
            ? "Describe who these characters are and what they are all in together"
            : "Describe who this character is and what it is like to talk to them"}
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
      <Field
        label="Accent colour"
        optional
        hint="Tints this creation's card edge, the glow behind its artwork and its main button. It never changes the text, so any colour stays readable."
      >
        <div className={styles.accentRow}>
          <input
            type="color"
            className={styles.accentPicker}
            value={draft.accent}
            aria-label="Accent colour"
            onChange={(event) => update({ accent: event.target.value })}
          />
          {/* Small on purpose. Enough to answer "what does this actually do?"
              without becoming a simulator of the whole product. */}
          <div className={styles.accentPreview} style={accentVariables(draft.accent) as React.CSSProperties} aria-hidden>
            <span className={styles.accentPreviewArt}>{(draft.title || draft.name).trim()[0]?.toUpperCase() || "A"}</span>
            <span className={styles.accentPreviewCta}>Start</span>
          </div>
          {draft.accent.toLowerCase() !== defaultAccent && <button
            type="button"
            className={styles.ghostButton}
            onClick={() => update({ accent: defaultAccent })}
          >Reset</button>}
        </div>
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
