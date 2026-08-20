/**
 * Server-side provider configuration.
 *
 * Model entitlements live here rather than in the per-user settings table so a
 * user can never select a model the deployment does not want to pay for. The
 * API key itself is read only inside the server-side DeepSeek client and is
 * never exposed to the browser.
 */

const fallbackModels = ["deepseek-v4-flash", "deepseek-v4-pro"];

export function allowedModels() {
  const configured = (process.env.ALLOWED_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9._-]{1,100}$/.test(item));
  return configured.length ? configured : fallbackModels;
}

export function defaultModel() {
  const configured = process.env.DEEPSEEK_MODEL?.trim();
  if (configured && allowedModels().includes(configured)) return configured;
  return allowedModels()[0];
}
