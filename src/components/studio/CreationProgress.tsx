"use client";

import { Check } from "lucide-react";
import styles from "./studio.module.css";

export type StudioStep = { id: string; label: string };

/**
 * Step indicator.
 *
 * Every step is reachable at any time: the draft is one object held in memory,
 * so jumping between steps never discards what has been typed.
 */
export function CreationProgress({ steps, current, onSelect }: {
  steps: StudioStep[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return <nav className={styles.progress} aria-label="Creation steps">
    {steps.map((step, index) => {
      const state = index === current ? "current" : index < current ? "done" : "upcoming";
      return <button
        key={step.id}
        type="button"
        className={styles.progressStep}
        data-state={state}
        aria-current={index === current ? "step" : undefined}
        onClick={() => onSelect(index)}
      >
        <span>{state === "done" ? <Check size={14} aria-hidden /> : index + 1}</span>
        {step.label}
      </button>;
    })}
  </nav>;
}
