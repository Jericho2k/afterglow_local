import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimGeneration, editTriggersGeneration, idleGenerationGate, releaseGeneration, type EditedMessage } from "@/lib/message-edit";

/**
 * EDITING THE TURN YOU ARE STILL COMPOSING.
 *
 * A reader types a message, the reply does not arrive — the generation failed,
 * or they left and came back — and they fix their sentence and press Save. What
 * they wanted next was obvious and they had to go and find a second control to
 * ask for it. Finishing that edit now asks for the reply.
 *
 * The dangerous version of this feature is the one that fires anywhere else.
 * Editing a turn in the middle of a story is a CORRECTION: the reply that
 * followed it was written, paid for and read, and generating over it — or even
 * appending a second reply beneath it — is the destructive reading of "edit"
 * that this deliberately is not. So the two halves are tested separately and
 * the negative half is the longer one.
 */

const user = (id: string): EditedMessage => ({ id, role: "user" });
const reply = (id: string): EditedMessage => ({ id, role: "assistant" });

describe("editing the newest unanswered message of your own", () => {
  it("asks for the reply that is missing", () => {
    const transcript = [reply("greeting"), user("u1"), reply("a1"), user("u2")];
    expect(editTriggersGeneration(transcript, "u2")).toBe(true);
  });

  it("works on the very first thing a reader says", () => {
    // The opening greeting is an assistant message, so a reader's first turn is
    // the newest message with nothing after it: the same case, at the start.
    expect(editTriggersGeneration([reply("greeting"), user("u1")], "u1")).toBe(true);
  });

  it("reads the newest message from the window, which is where the story ends", () => {
    /*
     * The transcript on screen is a WINDOW of the newest messages — a long
     * story opens on its tail and "Load earlier" prepends the rest. That is the
     * right input rather than a hazard: anything not loaded can only ever come
     * BEFORE what is here, so the last element is the end of the story whether
     * or not the beginning has been read.
     */
    const windowed = [user("u40"), reply("a40"), user("u41")];
    expect(editTriggersGeneration(windowed, "u41")).toBe(true);
    // And a message that is only the newest thing LOADED is still not the
    // newest thing there is — but that shape cannot occur, because the window
    // is the tail. What can occur is editing something above it.
    expect(editTriggersGeneration(windowed, "u40")).toBe(false);
  });
});

describe("editing anything else saves and stops", () => {
  const transcript = [reply("greeting"), user("u1"), reply("a1"), user("u2"), reply("a2")];

  it("does not generate when a reply already exists after the edited message", () => {
    // The complaint this guards: a reply that has been read is not re-asked for
    // by correcting a typo above it.
    expect(editTriggersGeneration(transcript, "u1")).toBe(false);
    expect(editTriggersGeneration(transcript, "u2")).toBe(false);
  });

  it("does not generate when the reader edits the character's words", () => {
    // Editing an assistant message is authoring, not asking. The reader has
    // just said what they wanted it to say; answering it again discards that.
    expect(editTriggersGeneration(transcript, "a2")).toBe(false);
    expect(editTriggersGeneration(transcript, "greeting")).toBe(false);
    expect(editTriggersGeneration([reply("only-greeting")], "only-greeting")).toBe(false);
  });

  it("does not generate for a message that is not in the transcript at all", () => {
    expect(editTriggersGeneration(transcript, "deleted-somewhere-else")).toBe(false);
    expect(editTriggersGeneration([], "u1")).toBe(false);
  });
});

describe("Save tapped twice starts exactly one generation", () => {
  /*
   * `streaming` state cannot close this on its own, and that is the whole
   * reason the gate exists. It answers one render late: two calls landing in
   * the same tick both read the value from the render they closed over, both
   * see `false`, and both start a turn. The reader gets two replies, two bills
   * and a transcript to repair.
   */
  it("lets the first caller through and refuses the second", () => {
    const gate = idleGenerationGate();
    expect(claimGeneration(gate)).toBe(true);
    // The second tap, before anything has re-rendered.
    expect(claimGeneration(gate)).toBe(false);
    expect(claimGeneration(gate)).toBe(false);
  });

  it("reopens when the turn finishes, however it finished", () => {
    const gate = idleGenerationGate();
    claimGeneration(gate);
    // Released in a `finally`, so a failed generation frees the gate exactly
    // like a successful one. A gate that only opened on success would be a chat
    // that stops answering after its first error.
    releaseGeneration(gate);
    expect(claimGeneration(gate)).toBe(true);
  });

  it("survives a release nobody claimed", () => {
    const gate = idleGenerationGate();
    releaseGeneration(gate);
    expect(gate.pending).toBe(false);
    expect(claimGeneration(gate)).toBe(true);
  });

  it("counts one generation across a save, a rerender and a second save", () => {
    /*
     * The sequence as the panel actually runs it: the decision is taken from
     * the transcript the reader was looking at, the save round-trips, and
     * anything that arrives while the turn is in flight — a repeated tap, a
     * rerender re-running an effect — finds the gate held.
     */
    const gate = idleGenerationGate();
    const transcript = [reply("greeting"), user("u1")];
    let generations = 0;
    for (const tap of [0, 1, 2]) {
      if (!editTriggersGeneration(transcript, "u1")) continue;
      if (!claimGeneration(gate)) continue;
      generations += 1;
      expect(tap).toBe(0);
    }
    expect(generations).toBe(1);
  });
});

/**
 * THE RULE IS ONLY WORTH ANYTHING IF THE PANEL ASKS IT.
 *
 * The decision above is pure and the chat panel is a large React component with
 * no test environment in this suite, so the wiring is asserted on the source:
 * that the panel calls the rule rather than re-deriving it from an index, that
 * the generation goes through `send` rather than through a second inference
 * path, and that both duplicate guards are in place.
 */
describe("the chat panel is wired to the rule rather than to a copy of it", () => {
  const shell = readFileSync("src/components/shell/AppShell.tsx", "utf8");

  it("decides with editTriggersGeneration and generates through the normal path", () => {
    expect(shell).toContain("editTriggersGeneration(messages, message.id)");
    // Reuse, not a second implementation: `send` is the one function that
    // builds a turn, streams it, prices it and handles its failures.
    expect(shell).toContain('if (generateReply) void send("continue")');
    expect(shell).not.toContain("editTriggersGeneration(messages, message.id) && index");
  });

  it("holds both guards against saving or generating twice", () => {
    expect(shell).toContain("if (editSaveRef.current === message.id) return;");
    expect(shell).toContain("if (!claimGeneration(generationGateRef.current)) return;");
    // Released in a `finally` on both, so a failure does not wedge the chat.
    expect(shell).toContain("finally { releaseGeneration(generationGateRef.current); setStreaming(false); }");
    expect(shell).toContain("finally { editSaveRef.current = null; }");
  });

  it("still refuses to discard the replies that follow an edited message", () => {
    // The PATCH that saves an edit truncates nothing, and this feature did not
    // change that: generating is only ever ADDING the reply that is missing.
    expect(shell).toContain("truncateAfter: false");
  });
});
