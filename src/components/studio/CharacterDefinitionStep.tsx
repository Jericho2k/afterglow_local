"use client";

import { MessageSquareQuote, Shield, Sliders, Users } from "lucide-react";
import { CastEditor } from "./CastEditor";
import { Counter, Disclosure, Field, TextArea, TextInput } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * Character definition.
 *
 * The visible surface is short; the depth is behind disclosures. Advanced
 * creators keep every long-form field the studio has ever had — response
 * directive, boundaries, example dialogue, supporting cast — without a first
 * timer meeting all of them at once.
 */
export function CharacterDefinitionStep({ draft, update, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onError: (message: string) => void;
}) {
  return <>
    <header className={styles.stepHead}>
      <h2>The character</h2>
      <p>Who they are and how they behave. Everything here shapes the roleplay; only what you wrote in Basics is shown publicly.</p>
    </header>

    <Field label="Character name" required hint="Their own name, which does not have to match the creation title.">
      <TextInput value={draft.name} maxLength={120} onChange={(value) => update({ name: value })} placeholder="Emily Carter" />
    </Field>

    <Field
      label="Personality & mannerisms"
      hint="Traits, contradictions, habits, body language, how they speak and how they treat people."
      counter={<Counter value={draft.personality.length} max={12000} />}
    >
      <TextArea
        value={draft.personality}
        maxLength={12000}
        size="tall"
        onChange={(value) => update({ personality: value })}
        placeholder="Quiet but observant. Speaks rarely and always means it. Protective of the people she has decided are hers…"
      />
    </Field>

    <Field
      label="Backstory & durable premise"
      hint="History, relationships, formative events, timeline — the facts that stay true across every chat."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} />
    </Field>

    <Field
      label="Scenario"
      optional
      hint="Where and how the story starts, and what is already happening when the reader arrives."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea value={draft.scenario} maxLength={12000} onChange={(value) => update({ scenario: value })} />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Who {{user}} is to this character, when that matters. Leave empty for an open conversation."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea value={draft.userRole} maxLength={4000} onChange={(value) => update({ userRole: value })} placeholder="Her new neighbour, three weeks into pretending not to notice each other." />
    </Field>

    <Disclosure
      icon={<MessageSquareQuote size={17} aria-hidden />}
      title="Voice & example dialogue"
      description="Sample exchanges that teach cadence, vocabulary and formatting."
      count={draft.exampleDialogue ? 1 : 0}
    >
      <Field
        label="Example dialogue"
        optional
        hint="Use {{char}} and {{user}} for the character and the reader."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea
          value={draft.exampleDialogue}
          maxLength={12000}
          size="tall"
          onChange={(value) => update({ exampleDialogue: value })}
          placeholder={"{{char}}: You're late.\n{{user}}: Sorry, there was traffic.\n{{char}}: Hm. Don't make it a habit."}
        />
      </Field>
    </Disclosure>

    <Disclosure
      icon={<Users size={17} aria-hidden />}
      title="Supporting characters"
      description="Optional. People the AI should know in detail alongside the lead."
      count={draft.cast.length}
    >
      <CastEditor
        cast={draft.cast}
        onChange={(cast) => update({ cast })}
        onError={onError}
        emptyNote="No supporting characters. The AI will still improvise people the story needs."
      />
    </Disclosure>

    <Disclosure
      icon={<Sliders size={17} aria-hidden />}
      title="Advanced AI instructions"
      description="Response rules and hidden direction. Never shown on the public page."
      count={(draft.responseDirective ? 1 : 0) + (draft.boundaries ? 1 : 0)}
    >
      <Field
        label="Response directive"
        optional
        hint="Voice, length, initiative, point of view, how NPCs are handled, formatting rules."
        counter={<Counter value={draft.responseDirective.length} max={8000} />}
      >
        <TextArea value={draft.responseDirective} maxLength={8000} size="tall" onChange={(value) => update({ responseDirective: value })} />
      </Field>
      <Field
        label="Boundaries"
        optional
        hint="Consent rules, topics to avoid, hard limits."
        counter={<Counter value={draft.boundaries.length} max={5000} />}
      >
        <TextArea value={draft.boundaries} maxLength={5000} onChange={(value) => update({ boundaries: value })} />
      </Field>
    </Disclosure>

    <SourceMaterial draft={draft} update={update} />
  </>;
}

/** Retained import source. Kept out of the prompt, kept for re-imports. */
export function SourceMaterial({ draft, update }: { draft: CreationDraft; update: (changes: Partial<CreationDraft>) => void }) {
  if (!draft.sourceMaterial.trim()) return null;
  return <Disclosure
    icon={<Shield size={17} aria-hidden />}
    title="Original import source"
    description="Preserved verbatim for review and future re-imports. It is never sent with a chat reply."
  >
    <Field label="Source material" optional counter={<Counter value={draft.sourceMaterial.length} max={100000} />}>
      <TextArea value={draft.sourceMaterial} maxLength={100000} size="tall" onChange={(value) => update({ sourceMaterial: value })} />
    </Field>
  </Disclosure>;
}
