"use client";

import { MessageSquareQuote, Sliders, Users } from "lucide-react";
import { CastEditor } from "./CastEditor";
import { SourceMaterial } from "./CharacterDefinitionStep";
import { Counter, Disclosure, Field, SectionCard, TextArea } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * Cast definition.
 *
 * Several individually modelled characters plus the premise they share. This
 * is not the same thing as a scenario: here every important person is defined
 * explicitly, and the shared fields describe what they are all in together.
 */
export function CastDefinitionStep({ draft, update, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onError: (message: string) => void;
}) {
  return <>
    <header className={styles.stepHead}>
      <h2>The cast</h2>
      <p>Define each important character, then the premise they all share.</p>
    </header>

    <SectionCard
      icon={<Users size={17} aria-hidden />}
      title={`Characters${draft.cast.length ? ` · ${draft.cast.length}` : ""}`}
      description="Define each character separately. Tap one to write its full definition, and reorder them to set who leads."
    >
      <CastEditor
        cast={draft.cast}
        onChange={(cast) => update({ cast })}
        onError={onError}
        emptyNote="No characters yet. Add the people this story is about — each one keeps their own personality instead of being compressed into a single lead."
      />
    </SectionCard>

    <Field
      label="Shared premise"
      hint="Describe what is happening between these characters and the situation the reader walks into."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea
        value={draft.scenario}
        maxLength={12000}
        size="tall"
        onChange={(value) => update({ scenario: value })}
        placeholder="Describe what they are all in together"
      />
    </Field>

    <Field
      label="Shared background & history"
      optional
      hint="Write the history and durable context the AI should remember about the whole group — events, relationships and facts that stay true in every chat."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} placeholder="Write what stays true for the whole cast" />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Describe who the reader is to this group, if the role is predefined. Leave it empty for an open situation."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea value={draft.userRole} maxLength={4000} onChange={(value) => update({ userRole: value })} placeholder="Describe who the reader plays, if their part is set" />
    </Field>

    <Disclosure
      icon={<MessageSquareQuote size={17} aria-hidden />}
      title="Group tone & example dialogue"
      description="Show the AI how this group sounds when they are all in a scene."
      count={(draft.personality ? 1 : 0) + (draft.exampleDialogue ? 1 : 0)}
    >
      <Field
        label="Group dynamic"
        optional
        hint="Describe how they behave as a group: rivalries, alliances, running jokes, who defers to whom and who talks over everybody."
        counter={<Counter value={draft.personality.length} max={12000} />}
      >
        <TextArea value={draft.personality} maxLength={12000} size="tall" onChange={(value) => update({ personality: value })} placeholder="Describe how they behave when they are together" />
      </Field>
      <Field
        label="Example dialogue"
        optional
        hint="Write an exchange that demonstrates the voice, formatting and conversational style you want. Use each character's name, or {{char}} and {{user}}."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea value={draft.exampleDialogue} maxLength={12000} size="tall" onChange={(value) => update({ exampleDialogue: value })} placeholder={"Maya: …\nSophie: …\n{{user}}: …"} />
      </Field>
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
        hint="Tell the AI how replies should be written: how to move between characters, who speaks when, point of view, pacing and formatting."
        counter={<Counter value={draft.responseDirective.length} max={8000} />}
      >
        <TextArea value={draft.responseDirective} maxLength={8000} size="tall" onChange={(value) => update({ responseDirective: value })} placeholder="Tell the AI how to handle the group and how to write" />
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
