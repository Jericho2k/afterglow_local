/**
 * Sharing a link, once, for every surface that shares one.
 *
 * There were two implementations. A creation offered the native share sheet
 * where the browser has one and fell back to the clipboard; a creator profile
 * only ever copied, and copied silently on the platforms where a share sheet
 * was sitting right there. Same control, same icon, two behaviours — and the
 * quieter one on the surface a creator is most likely to send to somebody.
 *
 * The order is deliberate. The native sheet FIRST, because it is the thing a
 * reader on a phone actually wants: it reaches the app they were going to paste
 * into anyway. The clipboard second, because on a desktop it is the whole of
 * what sharing means. A dismissed share sheet is not a failure and produces no
 * message; a copy is invisible and always produces one.
 */

export type ShareOutcome = "shared" | "copied" | "failed";

type Navigatorish = {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText?: (value: string) => Promise<void> };
};

export function shareMessage(outcome: ShareOutcome, subject: string) {
  if (outcome === "copied") return `${subject} link copied.`;
  if (outcome === "failed") return "Could not copy the link. Use your browser's address bar.";
  return "";
}

/**
 * @param subject  What is being shared, for the copied/failed message: "Profile", "Creation".
 * @returns The outcome, so the caller can show its own notice in its own place.
 */
export async function shareLink(
  { url, title, source }: { url: string; title?: string; source?: Navigatorish },
): Promise<ShareOutcome> {
  const agent = source ?? (typeof navigator === "undefined" ? undefined : navigator as Navigatorish);
  if (agent?.share) {
    try {
      await agent.share({ title, url });
      return "shared";
    } catch {
      // Dismissing the sheet lands here as well as a genuine failure, and the
      // two are indistinguishable by design. Falling through to the clipboard
      // is the better of the two guesses: a reader who dismissed it gets a
      // copied link they did not ask for, which costs nothing.
    }
  }
  if (!agent?.clipboard?.writeText) return "failed";
  try {
    await agent.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
