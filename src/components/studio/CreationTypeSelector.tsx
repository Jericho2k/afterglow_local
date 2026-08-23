"use client";

import { BookOpen, Check, Users, UserRound } from "lucide-react";
import type { CreationType } from "@/lib/types";
import styles from "./studio.module.css";

/**
 * The three authoring structures.
 *
 * Deliberately described in terms of what a creator is making rather than how
 * it is stored: "I am making a person", "several important people", or "an
 * experience". A scenario is never made to invent a primary character.
 */
const options: { value: CreationType; label: string; blurb: string; icon: typeof UserRound }[] = [
  {
    value: "character",
    label: "Character",
    blurb: "One primary character with their own personality, story and goals.",
    icon: UserRound,
  },
  {
    value: "cast",
    label: "Cast",
    blurb: "Several defined characters sharing one story — roommates, a party, a family.",
    icon: Users,
  },
  {
    value: "scenario",
    label: "Scenario / RPG",
    blurb: "A situation, story or world. The AI narrates and plays the characters in it — no single lead required.",
    icon: BookOpen,
  },
];

export function CreationTypeSelector({ value, onChange }: { value: CreationType; onChange: (value: CreationType) => void }) {
  return <div className={styles.typeCards} role="radiogroup" aria-label="What are you creating?">
    {options.map((option) => {
      const Icon = option.icon;
      const selected = option.value === value;
      return <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={selected}
        className={styles.typeCard}
        data-selected={selected ? "true" : "false"}
        onClick={() => onChange(option.value)}
      >
        <span className={styles.typeIcon}><Icon size={21} aria-hidden /></span>
        <span className={styles.typeCopy}>
          <strong>{option.label}</strong>
          <p>{option.blurb}</p>
        </span>
        {selected
          ? <Check size={20} className={styles.typeCheck} aria-hidden />
          : <span className={styles.typeCheckEmpty} aria-hidden />}
      </button>;
    })}
  </div>;
}
