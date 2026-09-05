"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";

/**
 * The gate a signed-in reader meets in front of adult content.
 *
 * Two variants, because there are two different questions and asking the wrong
 * one is its own failure:
 *
 *   "confirm" — this account has never stated its age. The reader is told what
 *   the creation contains and asked to confirm, once.
 *
 *   "enable" — this account confirmed long ago and has adult content switched
 *   off. Asking them to prove their age again would be asking a question they
 *   have already answered, so it asks the one they have not: do you want this
 *   on? A reader who deliberately opened an adult-focused creation with the
 *   preference off is not confused, they are making a choice.
 *
 * The affirmative action does both halves in one request and returns the
 * resolved state, so the reader continues into what they were opening instead
 * of landing on a page that tells them to reload.
 */

export type AdultState = { confirmedAdult: boolean; confirmedAt: string | null; adultContentEnabled: boolean };

export async function submitAdultState(body: { confirm?: true; adultContentEnabled?: boolean }): Promise<AdultState> {
  const response = await fetch("/api/adult", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "That could not be saved.");
  return data.adult as AdultState;
}

export function AdultGate({ variant, title, onContinue, onBack }: {
  /** Which question to ask. See the component's own note. */
  variant: "confirm" | "enable";
  /** What is being opened, so the gate is about something rather than generic. */
  title: string;
  onContinue: (state: AdultState) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    setBusy(true);
    setError("");
    try {
      // Confirming and enabling are one act from the reader's point of view:
      // they pressed a button that says they are 18 and want to continue.
      onContinue(await submitAdultState(variant === "confirm"
        ? { confirm: true, adultContentEnabled: true }
        : { adultContentEnabled: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That could not be saved.");
      setBusy(false);
    }
  }

  return <main className="gate">
    <div className="gate-card">
      <div className="gate-symbol" aria-hidden>18+</div>
      <span className="eyebrow">{variant === "confirm" ? "Adults only" : "Adult content is off"}</span>
      <h1>{variant === "confirm" ? "Before you open this." : "Turn adult content on?"}</h1>
      <p>
        <strong>{title}</strong> contains adult content.
        {variant === "confirm"
          ? " To open it, confirm that you are 18 or older and of legal age where you live."
          : " You have already confirmed your age. Adult content is currently switched off for your account."}
      </p>
      <div className="gate-actions">
        <button className="primary" disabled={busy} onClick={() => void accept()}>
          {busy ? "One moment…" : variant === "confirm" ? "I am 18+ — continue" : "Enable adult content — continue"}
        </button>
        <button className="secondary" disabled={busy} onClick={onBack}>Go back</button>
      </div>
      {error && <small className="form-error" role="alert">{error}</small>}
      <small>
        <ShieldAlert size={12} aria-hidden /> Afterglow prohibits sexual content involving minors, non-consensual
        exploitation, and real people. You can turn adult content off again at any time in Settings.
      </small>
    </div>
  </main>;
}
