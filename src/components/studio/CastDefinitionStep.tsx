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
      description="Tap a character to write their full definition. Reorder them to set who leads."
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
      hint="What is going on between them, and what the reader is walking into."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea
        value={draft.scenario}
        maxLength={12000}
        size="tall"
        onChange={(value) => update({ scenario: value })}
        placeholder="Three roommates, one apartment, and a lease none of them can afford to break…"
      />
    </Field>

    <Field
      label="Shared background & history"
      optional
      hint="Events, relationships and facts that stay true for the whole cast."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Who {{user}} is to this group."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea value={draft.userRole} maxLength={4000} onChange={(value) => update({ userRole: value })} placeholder="The fourth roommate who moved in last week." />
    </Field>

    <Disclosure
      icon={<MessageSquareQuote size={17} aria-hidden />}
      title="Group tone & example dialogue"
      description="How the cast sounds together, and any shared mannerisms."
      count={(draft.personality ? 1 : 0) + (draft.exampleDialogue ? 1 : 0)}
    >
      <Field
        label="Group dynamic"
        optional
        hint="How they behave as a group — rivalries, alliances, running jokes, who talks over whom."
        counter={<Counter value={draft.personality.length} max={12000} />}
      >
        <TextArea value={draft.personality} maxLength={12000} size="tall" onChange={(value) => update({ personality: value })} />
      </Field>
      <Field
        label="Example dialogue"
        optional
        hint="Use {{char}} and {{user}}, or write each character's name, to show how a scene between them reads."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea value={draft.exampleDialogue} maxLength={12000} size="tall" onChange={(value) => update({ exampleDialogue: value })} />
      </Field>
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
        hint="How to move between characters, who speaks when, point of view, formatting, pacing."
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
