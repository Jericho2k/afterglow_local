/**
 * Reading a stylesheet by INTENT rather than by byte sequence.
 *
 * A CSS assertion written as `expect(css).toContain(".x{a:1;b:2}")` fails the
 * moment anybody reformats the rule, reorders a declaration, or adds a third
 * property — none of which changes what the page looks like. Those failures
 * train people to paste the new bytes in without reading them, which is how a
 * test stops guarding anything at all.
 *
 * These helpers answer the question the test actually has: does this selector
 * declare this property, and what is its value.
 */

/** Every declaration block for `selector`, merged in source order. */
export function declarationsFor(css: string, selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  // Comments first: this stylesheet documents itself heavily, and a comment can
  // contain braces, selectors and colons that would otherwise be parsed as CSS.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Rules are `selectorList{declarations}`; a block containing no further
  // braces is a leaf rule, which is what flattens the at-rules around them.
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(pattern)) {
    const selectors = match[1].split(",").map((item) => item.trim().split(/[{}]/).pop()!.trim());
    if (!selectors.some((item) => item === selector || item.endsWith(` ${selector}`))) continue;
    for (const declaration of splitDeclarations(match[2])) {
      const colon = declaration.indexOf(":");
      if (colon < 1) continue;
      merged[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return merged;
}

/** True when `selector` declares `property` anywhere, with any value. */
export function declares(css: string, selector: string, property: string) {
  return property in declarationsFor(css, selector);
}

/** Semicolons inside `url()`, `calc()` and friends do not end a declaration. */
function splitDeclarations(block: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of block) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === ";" && depth === 0) { parts.push(current); current = ""; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((item) => item.trim()).filter(Boolean);
}
