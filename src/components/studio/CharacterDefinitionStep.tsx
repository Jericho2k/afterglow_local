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

    <Field label="Character name" required hint="Write the name this character is called by. It does not have to match the creation title.">
      <TextInput value={draft.name} maxLength={120} onChange={(value) => update({ name: value })} placeholder="The character's own name" />
    </Field>

    <Field
      label="Personality & mannerisms"
      hint="Describe how this character thinks, reacts, speaks and behaves — traits, contradictions, habits, body language, and how they treat the people around them."
      counter={<Counter value={draft.personality.length} max={12000} />}
    >
      <TextArea
        value={draft.personality}
        maxLength={12000}
        size="tall"
        onChange={(value) => update({ personality: value })}
        placeholder="Write their traits, habits, contradictions and manner"
      />
    </Field>

    <Field
      label="Backstory & durable premise"
      hint="Write the history and durable context the AI should remember about this character: formative events, relationships, timeline — the facts that stay true in every chat."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} placeholder="Write the history and context that stay true across every chat" />
    </Field>

    <Field
      label="Scenario"
      optional
      hint="Describe what is happening and the situation the reader enters — where the story starts and what is already in motion."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea value={draft.scenario} maxLength={12000} onChange={(value) => update({ scenario: value })} placeholder="Describe the situation the first message opens on" />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Describe who the reader is to this character, if the role is predefined. Leave it empty for an open conversation."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea value={draft.userRole} maxLength={4000} onChange={(value) => update({ userRole: value })} placeholder="Describe who the reader plays, if their part is set" />
    </Field>

    <Disclosure
      icon={<MessageSquareQuote size={17} aria-hidden />}
      title="Voice & example dialogue"
      description="Show the AI the voice, formatting and conversational style to write in."
      count={draft.exampleDialogue ? 1 : 0}
    >
      <Field
        label="Example dialogue"
        optional
        hint="Write dialogue that demonstrates the voice, formatting and conversational style you want. Use {{char}} for the character and {{user}} for the reader."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea
          value={draft.exampleDialogue}
          maxLength={12000}
          size="tall"
          onChange={(value) => update({ exampleDialogue: value })}
          placeholder={"{{char}}: …\n{{user}}: …\n{{char}}: …"}
        />
      </Field>
    </Disclosure>

    <Disclosure
      icon={<Users size={17} aria-hidden />}
      title="Supporting characters"
      description="Optional. Define anyone else the AI should know in detail alongside the lead."
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
      description="Rules for how the AI writes. Never shown on the public page."
      count={(draft.responseDirective ? 1 : 0) + (draft.boundaries ? 1 : 0)}
    >
      <Field
        label="Response directive"
        optional
        hint="Tell the AI how replies should be written and what behaviour it should follow consistently — voice, length, point of view, initiative, how NPCs are handled, formatting."
        counter={<Counter value={draft.responseDirective.length} max={8000} />}
      >
        <TextArea value={draft.responseDirective} maxLength={8000} size="tall" onChange={(value) => update({ responseDirective: value })} placeholder="Tell the AI how to write and what to do consistently" />
      </Field>
      <Field
        label="Boundaries"
        optional
        hint="State the consent rules, hard limits and topics this roleplay must never go near."
        counter={<Counter value={draft.boundaries.length} max={5000} />}
      >
        <TextArea value={draft.boundaries} maxLength={5000} onChange={(value) => update({ boundaries: value })} placeholder="State the limits this roleplay must respect" />
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
    <Field label="Source material" optional hint="Your original paste, kept exactly as it arrived. Edit it only if you want a future re-import to read something different." counter={<Counter value={draft.sourceMaterial.length} max={100000} />}>
      <TextArea value={draft.sourceMaterial} maxLength={100000} size="tall" onChange={(value) => update({ sourceMaterial: value })} />
    </Field>
  </Disclosure>;
}
