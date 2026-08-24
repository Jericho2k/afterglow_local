"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui";
import styles from "./shell.module.css";

/**
 * One dialog, for everything that used to open its own.
 *
 * The app had accumulated a modal, a right-hand drawer and several
 * one-off backdrops, each with its own radii, padding, close affordance and
 * escape handling — and a couple with none. This is the single surface they
 * all use now: a bottom sheet on a phone, a centred panel on a desktop, with
 * the product's own borders, serif heading and safe-area-aware footer.
 *
 * Behaviour is the part that was inconsistent and matters most: Escape always
 * closes, a click on the backdrop always closes, a click that merely STARTED
 * on the backdrop after a drag inside the panel does not, focus moves in on
 * open and returns to whatever opened it on close, and the page behind never
 * scrolls underneath.
 */
export function Sheet({ title, eyebrow, onClose, children, footer, labelledBy }: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<Element | null>(null);
  // Whether the pointer went down on the backdrop rather than inside the
  // panel. Without this, selecting text and releasing outside closes the sheet.
  const startedOnBackdrop = useRef(false);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("input, textarea, select, button, [tabindex]")?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
    };
  }, [close]);

  return <div
    className={styles.sheetBackdrop}
    onMouseDown={(event) => { startedOnBackdrop.current = event.target === event.currentTarget; }}
    onMouseUp={(event) => { if (startedOnBackdrop.current && event.target === event.currentTarget) close(); }}
  >
    <div className={styles.sheet} ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : title}>
      <header className={styles.sheetHeader}>
        <div>
          {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
          <h2 id={labelledBy}>{title}</h2>
        </div>
        <IconButton label="Close" tone="subtle" onClick={close}><X size={18} aria-hidden /></IconButton>
      </header>
      <div className={styles.sheetBody}>{children}</div>
      {footer && <footer className={styles.sheetFooter}>{footer}</footer>}
    </div>
  </div>;
}
