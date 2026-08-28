"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import styles from "./ui.module.css";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
};

type MenuPosition = { left: number; top: number; width: number; maxHeight: number };

/**
 * Afterglow's shared single-choice control.
 *
 * The menu is portalled and positioned from the trigger so it cannot be
 * clipped by a sheet, card, or horizontal scroller. It flips above when the
 * lower viewport is too short, clamps to the viewport on narrow phones, and
 * keeps the native select's useful keyboard contract without inheriting the
 * browser's unrelated visual language.
 */
export function SelectField({
  label,
  value,
  options,
  onChange,
  className = "",
  compact = false,
  hideLabel = false,
  disabled = false,
  row = false,
  icon,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  /** Draw as a settings row, with the field label inside the trigger. */
  row?: boolean;
  icon?: ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? null;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const gap = 6;
    const estimated = Math.min(340, Math.max(72, options.length * 52 + 12));
    const below = window.innerHeight - rect.bottom - gutter;
    const above = rect.top - gutter;
    const flip = below < Math.min(220, estimated) && above > below;
    const maxHeight = Math.max(120, Math.min(340, flip ? above - gap : below - gap));
    const width = Math.min(Math.max(rect.width, compact ? 170 : 220), window.innerWidth - gutter * 2);
    const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter);
    const top = flip
      ? Math.max(gutter, rect.top - Math.min(estimated, maxHeight) - gap)
      : Math.min(window.innerHeight - gutter, rect.bottom + gap);
    setPosition({ left, top, width, maxHeight });
  }, [compact, options.length]);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
  }, [close, onChange, options]);

  const show = useCallback((index = selectedIndex) => {
    if (disabled || !options.length) return;
    setActive(Math.min(Math.max(0, index), options.length - 1));
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    place();
    const update = () => place();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open || !position) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[active]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close, open]);

  function move(next: number) {
    const bounded = (next + options.length) % options.length;
    setActive(bounded);
  }

  function onTriggerKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(selectedIndex);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) close();
      else show();
    }
  }

  function onMenuKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Tab") close(false);
  }

  const menu = open && position && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={menuRef}
        id={`${id}-menu`}
        className={styles.selectMenu}
        role="listbox"
        aria-label={label}
        tabIndex={-1}
        style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
        onKeyDown={onMenuKey}
      >
        {options.map((option, index) => <button
          ref={(node) => { optionRefs.current[index] = node; }}
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={`${styles.selectOption} ${index === active ? styles.selectOptionActive : ""}`}
          onPointerMove={() => setActive(index)}
          onClick={() => choose(index)}
        >
          <span>
            <strong>{option.label}</strong>
            {option.description && <small>{option.description}</small>}
          </span>
          {option.value === value && <Check size={15} strokeWidth={2.5} aria-hidden />}
        </button>)}
      </div>,
      document.body,
    )
    : null;

  return <div className={`${styles.selectField} ${compact ? styles.selectCompact : ""} ${row ? styles.selectRow : ""} ${className}`}>
    <span id={`${id}-label`} className={hideLabel || row ? styles.srOnly : styles.selectLabel}>{label}</span>
    <button
      ref={triggerRef}
      type="button"
      className={styles.selectTrigger}
      aria-labelledby={`${id}-label`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `${id}-menu` : undefined}
      disabled={disabled}
      onClick={() => open ? close() : show()}
      onKeyDown={onTriggerKey}
    >
      {row && icon && <span className={styles.selectRowIcon} aria-hidden>{icon}</span>}
      <span className={row ? styles.selectRowCopy : undefined}>
        {row && <em>{label}</em>}
        <strong>{selected?.label ?? "Choose"}</strong>
        {selected?.description && <small>{selected.description}</small>}
      </span>
      <ChevronDown className={open ? styles.selectChevronOpen : styles.selectChevron} size={15} aria-hidden />
    </button>
    {menu}
  </div>;
}
