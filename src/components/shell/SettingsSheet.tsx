"use client";

import { useEffect, useState } from "react";
import { Database, Download, Gauge, Sparkles, Upload } from "lucide-react";
import type { AppSettings, ModelCatalog, UsageResponse } from "@/lib/types";
import { api } from "@/lib/api-client";
import { responseLengthBudget } from "@/lib/response-length";
import { responseLengths } from "@/lib/types";
import { uiStyles } from "@/components/ui";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * Settings.
 *
 * Same settings, grouped by what they are for rather than by the order they
 * were added: the writer new stories start with, the memory tuning only an
 * operator should touch, the usage ledger, and backup. No meaning is changed
 * and no option is invented — every control below writes a field
 * `/api/settings` already accepted.
 *
 * The one genuinely new thing is honesty about Response Length. It now decides
 * an output budget as well as a directive, so the sheet shows the budget each
 * choice implies rather than leaving the reader to discover it.
 */

const number = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const usd = (value: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD",
  minimumFractionDigits: value < 0.01 ? 5 : 2,
  maximumFractionDigits: value < 0.01 ? 6 : 4,
}).format(value);
const percent = (value: number | null) => value == null ? "—" : `${Math.round(value * 100)}%`;

const usageLabels: Record<string, string> = {
  chat: "Replies", regenerate: "Regenerations", continue: "Continuations",
  memory_consolidation: "Memory updates", memory_curation: "Canon curation",
  scene_state: "Scene grounding", character_generation: "Creation generation/import",
  embedding: "Embeddings",
};

const lengthCopy: Record<string, string> = {
  concise: "Fewer beats, tighter action and dialogue. Visibly shorter than Natural.",
  natural: "Adaptive. A short exchange stays short; a big moment breathes.",
  detailed: "Fuller action, dialogue, subtext and consequence when the scene supports it.",
};

export function SettingsSheet({ isAdmin, settings, models, catalog, onClose, onSaved, onImported }: {
  isAdmin: boolean;
  settings: AppSettings;
  models: string[];
  catalog: ModelCatalog;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
  onImported: () => void;
}) {
  const [form, setForm] = useState(settings);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => { if (isAdmin) api<UsageResponse>("/api/usage").then(setUsage).catch(() => undefined); }, [isAdmin]);

  async function save() {
    setBusy(true); setError("");
    try {
      const data = await api<{ settings: AppSettings }>("/api/settings", { method: "PATCH", body: JSON.stringify(form) });
      onSaved(data.settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save settings");
      setBusy(false);
    }
  }

  const providerModels = catalog.models.length
    ? catalog.models.filter((model) => model.providerId === form.providerId)
    : models.map((id) => ({ id, label: id, providerId: form.providerId, description: "", supportsThinking: true }));

  return <Sheet
    eyebrow="Your account"
    title="Settings"
    onClose={onClose}
    footer={<>
      <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={onClose}>Cancel</button>
      <button className={`${uiStyles.button} ${uiStyles.primary}`} disabled={busy} onClick={() => void save()}>
        {busy ? "Working…" : "Save settings"}
      </button>
    </>}
  >
    <section className={styles.card}>
      <div className={styles.cardHeader}><Sparkles size={16} aria-hidden /><h2>Defaults for new stories</h2></div>
      <div className={styles.stack}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="settings-provider">Provider</label>
          <select
            id="settings-provider"
            className={styles.select}
            value={form.providerId}
            onChange={(event) => {
              const providerId = event.target.value;
              const first = catalog.models.find((model) => model.providerId === providerId);
              setForm({ ...form, providerId, model: first?.id || form.model });
            }}
          >
            {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="settings-model">Writer</label>
          {/* Product names only. The upstream slug behind each one is a
              deployment detail and stays out of ordinary UI. */}
          <select
            id="settings-model"
            className={styles.select}
            value={form.model}
            onChange={(event) => {
              const model = catalog.models.find((item) => item.id === event.target.value);
              setForm({ ...form, providerId: model?.providerId || form.providerId, model: event.target.value });
            }}
          >
            {providerModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          <span className={styles.fieldHint}>{providerModels.find((model) => model.id === form.model)?.description}</span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="settings-engine">Roleplay engine</label>
          <select
            id="settings-engine"
            className={styles.select}
            value={form.roleplayPreset}
            onChange={(event) => setForm({ ...form, roleplayPreset: event.target.value as AppSettings["roleplayPreset"] })}
          >
            {catalog.engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
          </select>
          <span className={styles.fieldHint}>{catalog.engines.find((engine) => engine.id === form.roleplayPreset)?.description}</span>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Response length</span>
          <div className={styles.tabs} role="radiogroup" aria-label="Default response length">
            {responseLengths.map((length) => <button
              key={length}
              role="radio"
              aria-checked={form.responseLength === length}
              className={`${styles.tab} ${form.responseLength === length ? styles.tabActive : ""}`}
              onClick={() => setForm({ ...form, responseLength: length })}
            >{length[0].toUpperCase()}{length.slice(1)}</button>)}
          </div>
          <span className={styles.fieldHint}>
            {lengthCopy[form.responseLength]}{" "}
            {/* The envelope, stated. It is a ceiling well above the length the
                mode asks for, not a target, and saying so avoids the reading
                that Concise truncates. */}
            Replies are given up to about {responseLengthBudget(form.responseLength, form.maxTokens).toLocaleString()} tokens of room — a ceiling, not a target.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="settings-temperature">Creativity</label>
          <input
            id="settings-temperature"
            className={styles.input}
            type="number" min="0" max="2" step="0.05"
            value={form.temperature}
            onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })}
          />
        </div>

        <p className={styles.fieldHint}>
          These apply when a new story is created. Every existing conversation keeps its own writer, engine, length and creativity, and changing them there never resets continuity.
        </p>
      </div>
    </section>

    {isAdmin && <section className={styles.card}>
      <div className={styles.cardHeader}><Gauge size={16} aria-hidden /><h2>Memory &amp; context</h2></div>
      <div className={styles.stack}>
        {([
          ["contextMessages", "Recent messages", 8, 100, 1],
          ["contextTokenBudget", "Recent context tokens", 4000, 100_000, 1000],
          ["memoryLimit", "Relevant memory slots", 1, 20, 1],
          ["memoryTokenBudget", "Memory context tokens", 1000, 30_000, 500],
          ["consolidationInterval", "Consolidate every N messages", 6, 50, 1],
          ["maxTokens", "Reply ceiling at Natural", 256, 8000, 128],
        ] as const).map(([key, label, min, max, step]) => <div className={styles.field} key={key}>
          <label className={styles.fieldLabel} htmlFor={`settings-${key}`}>{label}</label>
          <input
            id={`settings-${key}`}
            className={styles.input}
            type="number" min={min} max={max} step={step}
            value={form[key]}
            onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })}
          />
        </div>)}
        <p className={styles.fieldHint}>
          The permanent archive has no reply-count cap. The token budgets control how much is recalled at once; active promises, boundaries and unresolved loops keep protected priority. The reply ceiling is the Natural baseline — Concise and Detailed scale from it.
        </p>
      </div>
    </section>}

    {isAdmin && usage && <section className={styles.card}>
      <div className={styles.cardHeader}><Database size={16} aria-hidden /><h2>Usage &amp; cost</h2></div>
      <dl className={styles.metrics}>
        <div className={styles.metric}><dt>API calls</dt><dd>{number(usage.usage.requests)}</dd></div>
        <div className={styles.metric}><dt>Input tokens</dt><dd>{number(usage.usage.promptTokens)}</dd></div>
        <div className={styles.metric}><dt>Output tokens</dt><dd>{number(usage.usage.completionTokens)}</dd></div>
        {/* The caching work is judged on these three, so they get their own
            tiles rather than a line in a breakdown. */}
        <div className={styles.metric}>
          <dt>Cache hit</dt>
          <dd>{percent(usage.usage.cachedRatio)}</dd>
          <small>{number(usage.usage.cacheHitTokens)} cached in</small>
        </div>
        <div className={styles.metric}>
          <dt>Cache writes</dt>
          <dd>{number(usage.usage.cacheWriteTokens ?? 0)}</dd>
        </div>
        <div className={styles.metric}>
          <dt>Total cost</dt>
          <dd>{usd(usage.usage.estimatedCostUsd)}</dd>
          <small>{usd(usage.costPer100UserMessages || 0)} / 100 messages</small>
        </div>
        {usage.usage.avgLatencyMs != null && <div className={styles.metric}>
          <dt>Latency</dt>
          <dd>{usage.usage.avgLatencyMs.toLocaleString()}<small> ms</small></dd>
          {usage.usage.avgTtftMs != null && <small>{usage.usage.avgTtftMs.toLocaleString()} ms to first token</small>}
        </div>}
      </dl>

      <div className={styles.stack} style={{ marginTop: 14 }}>
        {usage.byType.map((item) => <div key={item.key} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 13 }}>{usageLabels[item.key] ?? item.key}</strong>
            <br />
            <small className={styles.fieldHint}>{item.requests} calls · {number(item.promptTokens + item.completionTokens)} tokens · {percent(item.cachedRatio)} cached</small>
          </span>
          <b style={{ fontVariantNumeric: "tabular-nums" }}>{usd(item.estimatedCostUsd)}</b>
        </div>)}
      </div>

      {usage.byUpstreamProvider && usage.byUpstreamProvider.length > 0 && <div style={{ marginTop: 14 }}>
        <span className={styles.fieldLabel}>Upstream providers</span>
        <div className={styles.stack} style={{ marginTop: 8 }}>
          {usage.byUpstreamProvider.map((item) => <div key={item.key} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <span className={styles.fieldHint}>{item.key} · {item.requests} calls · {percent(item.cachedRatio)} cached</span>
            <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{usd(item.estimatedCostUsd)}</b>
          </div>)}
        </div>
      </div>}

      <p className={styles.fieldHint} style={{ marginTop: 12 }}>
        Prices as of {usage.pricingAsOf}. Cached input is charged at a fraction of fresh input, so a high cache hit rate on a long conversation is where the saving is.
      </p>
    </section>}

    <section className={styles.card}>
      <div className={styles.cardHeader}><Download size={16} aria-hidden /><h2>Backup</h2></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
        <a className={`${uiStyles.button} ${uiStyles.secondary}`} href="/api/backup" download>
          <Download size={15} aria-hidden />Export JSON
        </a>
        <label className={`${uiStyles.button} ${uiStyles.secondary}`} style={{ cursor: "pointer" }}>
          <Upload size={15} aria-hidden />Import backup
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (!window.confirm("Import this backup as additional creations and chats?")) { event.target.value = ""; return; }
              setBusy(true); setError("");
              try {
                const result = await api<{ imported: Record<string, number> }>("/api/backup", { method: "POST", body: await file.text() });
                setNotice(`Imported ${result.imported.characters} creations and ${result.imported.messages} messages.`);
                await onImported();
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "Import failed");
              } finally { setBusy(false); event.target.value = ""; }
            }}
          />
        </label>
      </div>
      <p className={styles.fieldHint} style={{ marginTop: 10 }}>
        Backups include your profile, creations, worlds, chats and settings{isAdmin ? ", including continuity archives" : ""} — never passwords or API keys.
      </p>
    </section>

    {notice && <p className={styles.notice}>{notice}</p>}
    {error && <p className={styles.error}>{error}</p>}
  </Sheet>;
}
