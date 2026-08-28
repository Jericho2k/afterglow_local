"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import styles from "./ui.module.css";

/** A single, truncation-safe row for a setting that opens a deeper picker. */
export function SettingsChoiceRow({
  icon,
  label,
  value,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return <button type="button" className={styles.settingsChoiceRow} {...button}>
    <span className={styles.settingsChoiceIcon} aria-hidden>{icon}</span>
    <span className={styles.settingsChoiceCopy}>
      <strong>{label}</strong>
      <small title={value}>{value}</small>
    </span>
    <ChevronRight size={15} aria-hidden />
  </button>;
}
