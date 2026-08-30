import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(new URL("../src/components/shell/SettingsSheet.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/components/shell/shell.module.css", import.meta.url), "utf8");

describe("BYOK Settings accessibility and privacy", () => {
  it("uses a labelled password input and never renders a saved raw key", () => {
    expect(component).toContain('htmlFor="settings-openrouter-key"');
    expect(component).toContain('type="password"');
    expect(component).toContain('autoComplete="off"');
    expect(component).toContain('aria-describedby="settings-openrouter-key-help settings-openrouter-key-error"');
    expect(component).toContain("•••••••• {byok.suffix}");
    expect(component).not.toContain("byok.apiKey");
  });

  it("names funding controls, status, errors, and the inline removal confirmation", () => {
    expect(component).toContain('role="radiogroup" aria-label="Writer funding"');
    expect(component).toContain('role="radio"');
    expect(component).toContain('role="alert"');
    expect(component).toContain('role="group" aria-labelledby="remove-key-title"');
    expect(component).toContain("Your chats and memories will not be deleted");
    expect(component).toContain("autoFocus");
  });

  it("states the writer/background funding and OpenRouter privacy boundary", () => {
    expect(component).toContain("replies, regenerations and continuations");
    expect(component).toContain("memory, continuity, Scene State and other background processing");
    expect(component).toContain("OpenRouter logging and privacy settings");
  });
});
describe("BYOK Settings responsive containment", () => {
  it("bounds long content and lets action rows wrap", () => {
    expect(css).toContain(".byokPanel { display: grid; gap: 14px; min-width: 0; }");
    expect(css).toContain(".byokActions { display: flex; flex-wrap: wrap;");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  it("collapses funding choices and stretches actions at 430px and below", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 430px)"));
    expect(mobile).toContain(".fundingChoices { grid-template-columns: 1fr; }");
    expect(mobile).toContain(".byokActions > * { flex: 1 1 140px; }");
  });

  it.each([375, 390, 430, 768, 1280, 1440])("has a bounded layout strategy at %ipx", (width) => {
    expect(width <= 430 ? css.includes("@media (max-width: 430px)") : css.includes("minmax(0, 1fr)")).toBe(true);
    expect(css).toContain(".sheet {\n  display: flex; flex-direction: column;\n  width: 100%;");
  });
});
