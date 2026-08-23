"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./studio.module.css";

/**
 * Form primitives for the studio.
 *
 * A creator writing a two-word name and a creator writing a two-thousand word
 * definition are doing different jobs, so fields differ in height, and every
 * label states plainly whether it is required.
 */

export function Field({ label, hint, required, optional, counter, children }: {
  label: string;
  hint?: string;
  required?: boolean;
  optional?: boolean;
  counter?: ReactNode;
  children: ReactNode;
}) {
  return <div className={styles.field}>
    <span className={styles.fieldLabel}>
      {label}
      {required && <span className={styles.required} aria-hidden>*</span>}
      {required && <span className={styles.srOnly}> (required)</span>}
      {optional && !required && <span className={styles.optional}>optional</span>}
    </span>
    {hint && <span className={styles.hint}>{hint}</span>}
    {children}
    {counter && <div className={styles.fieldFoot}>{counter}</div>}
  </div>;
}

export function Counter({ value, max }: { value: number; max: number }) {
  const near = value > max * 0.9;
  return <span className={`${styles.counter} ${near ? styles.counterWarn : ""}`}>{value.toLocaleString()} / {max.toLocaleString()}</span>;
}

export function TextInput({ value, onChange, placeholder, maxLength, autoFocus, inputMode }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  inputMode?: "text" | "search";
}) {
  return <input
    className={styles.input}
    value={value}
    maxLength={maxLength}
    autoFocus={autoFocus}
    inputMode={inputMode}
    placeholder={placeholder}
    onChange={(event) => onChange(event.target.value)}
  />;
}

/**
 * Long-form creator input. `size` decides the resting height: an opening
 * message or a full definition starts tall because that is what people
 * actually write there.
 */
export function TextArea({ value, onChange, placeholder, maxLength, size = "normal" }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  size?: "normal" | "tall" | "epic";
}) {
  const sizeClass = size === "epic" ? styles.epic : size === "tall" ? styles.tall : "";
  return <textarea
    className={`${styles.textarea} ${sizeClass}`}
    value={value}
    maxLength={maxLength}
    placeholder={placeholder}
    onChange={(event) => onChange(event.target.value)}
  />;
}

export function SectionCard({ icon, title, description, action, children }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return <section className={styles.card}>
    <div className={styles.cardHead}>
      {icon}
      <div>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      {action}
    </div>
    {children}
  </section>;
}

/**
 * Progressive disclosure. Advanced controls stay available without being the
 * first thing a first-time creator meets, and the summary count shows when
 * something is hidden inside.
 */
export function Disclosure({ icon, title, description, count, defaultOpen = false, children }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return <section className={styles.disclosure}>
    <button type="button" className={styles.disclosureButton} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      {icon}
      <span className={styles.disclosureCopy}>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      {count ? <span className={styles.disclosureCount}>{count}</span> : null}
      <ChevronDown size={17} className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} />
    </button>
    {open && <div className={styles.disclosureBody} id={id}>{children}</div>}
  </section>;
}

export function Toggle({ label, description, checked, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <button type="button" className={styles.toggleRow} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
    <span className={styles.toggleCopy}>
      <strong>{label}</strong>
      {description && <small>{description}</small>}
    </span>
    <span className={`${styles.switch} ${checked ? styles.switchOn : ""}`} aria-hidden />
  </button>;
}

export type Choice<T extends string> = { value: T; label: string; description?: string };

/**
 * A radio group rendered as cards. Selection is shown by both a mark and a
 * border, never by colour alone.
 */
export function ChoiceList<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return <div className={styles.optionList} role="radiogroup" aria-label={label}>
    {options.map((option) => {
      const selected = option.value === value;
      return <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={selected}
        className={`${styles.option} ${selected ? styles.optionSelected : ""}`}
        onClick={() => onChange(option.value)}
      >
        {selected
          ? <Check size={17} className={styles.optionMark} aria-hidden />
          : <span className={styles.typeCheckEmpty} style={{ width: 17, height: 17, marginTop: 2 }} aria-hidden />}
        <span className={styles.optionCopy}>
          <strong>{option.label}</strong>
          {option.description && <small>{option.description}</small>}
        </span>
      </button>;
    })}
  </div>;
}
