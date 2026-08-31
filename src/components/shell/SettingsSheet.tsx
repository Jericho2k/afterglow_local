"use client";

import { useEffect, useState } from "react";
import { Database, Download, Gauge, KeyRound, ShieldCheck, Sparkles, Upload } from "lucide-react";
import type { AppSettings, ModelCatalog, RoutingDiagnosticResponse, UsageResponse } from "@/lib/types";
import type { ByokMetadata, WriterFundingPreference } from "@/lib/byok";
import type { UsageRangeId } from "@/lib/usage-range";
import { api } from "@/lib/api-client";
import { responseLengthBudget } from "@/lib/response-length";
import { responseLengths } from "@/lib/types";
import { SelectField, uiStyles } from "@/components/ui";
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

/** The windows an operator actually asks about. */
const usageRanges: Array<{ id: UsageRangeId; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

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
  const [routing, setRouting] = useState<RoutingDiagnosticResponse | null>(null);
  const [usageRange, setUsageRange] = useState<UsageRangeId>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [byok, setByok] = useState<ByokMetadata | null>(null);
  const [byokKey, setByokKey] = useState("");
  const [byokBusy, setByokBusy] = useState(false);
  const [byokError, setByokError] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => { setForm(settings); }, [settings]);

  useEffect(() => {
    let live = true;
    api<ByokMetadata>("/api/byok")
      .then((value) => { if (live) setByok(value); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  /*
   * The ledger for one window.
   *
   * The offset goes with the request because "today" and "this month" are the
   * READER'S day and month, and the server cannot know which clock they are on.
   * The filtering itself is SQL: an account with a year of history must not
   * download its ledger to a browser to have it sliced there.
   *
   * A custom range only asks once both ends exist, so typing a start date does
   * not fire a request for a range with no end.
   */
  useEffect(() => {
    if (!isAdmin) return;
    if (usageRange === "custom" && !(customFrom && customTo)) return;
    const query = new URLSearchParams({ range: usageRange, offset: String(new Date().getTimezoneOffset()) });
    if (usageRange === "custom") { query.set("from", customFrom); query.set("to", customTo); }
    let live = true;
    setUsageLoading(true);
    api<UsageResponse>(`/api/usage?${query}`)
      .then((data) => { if (live) setUsage(data); })
      .catch(() => undefined)
      .finally(() => { if (live) setUsageLoading(false); });
    /*
     * The routing diagnostic rides the SAME window as the ledger above.
     *
     * Two panels describing different periods is worse than one panel
     * describing the wrong one, so the range chips drive both. It is fetched
     * separately rather than folded into /api/usage because it is a per-
     * conversation scan rather than an aggregate, and a failure to produce it
     * must not take the spend report down with it.
     */
    api<RoutingDiagnosticResponse>(`/api/usage/routing?${query}`)
      .then((data) => { if (live) setRouting(data); })
      .catch(() => { if (live) setRouting(null); });
    return () => { live = false; };
  }, [isAdmin, usageRange, customFrom, customTo]);

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

  async function connectKey() {
    if (!byokKey.trim()) return;
    setByokBusy(true); setByokError("");
    try {
      const value = await api<ByokMetadata>("/api/byok", { method: "POST", body: JSON.stringify({ apiKey: byokKey }) });
      // The raw key is write-only browser state. Drop it immediately after the
      // response; the server returns suffix/validation metadata only.
      setByokKey(""); setByok(value); setEditingKey(false);
    } catch (reason) {
      setByokError(reason instanceof Error ? reason.message : "Could not connect the key");
    } finally { setByokBusy(false); }
  }

  async function chooseFunding(writerFunding: WriterFundingPreference) {
    setByokBusy(true); setByokError("");
    try {
      setByok(await api<ByokMetadata>("/api/byok", { method: "PATCH", body: JSON.stringify({ writerFunding }) }));
    } catch (reason) {
      setByokError(reason instanceof Error ? reason.message : "Could not change writer funding");
    } finally { setByokBusy(false); }
  }

  async function removeKey() {
    setByokBusy(true); setByokError("");
    try {
      setByok(await api<ByokMetadata>("/api/byok", { method: "DELETE" }));
      setByokKey(""); setEditingKey(false); setConfirmRemove(false);
    } catch (reason) {
      setByokError(reason instanceof Error ? reason.message : "Could not remove the key");
    } finally { setByokBusy(false); }
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
          <SelectField
            label="Provider"
            value={form.providerId}
            onChange={(providerId) => {
              const first = catalog.models.find((model) => model.providerId === providerId);
              setForm({ ...form, providerId, model: first?.id || form.model });
            }}
            options={catalog.providers.map((provider) => ({ value: provider.id, label: provider.label }))}
          />
        </div>

        <div className={styles.field}>
          {/* Product names only. The upstream slug behind each one is a
              deployment detail and stays out of ordinary UI. */}
          <SelectField
            label="Writer"
            value={form.model}
            onChange={(value) => {
              const model = catalog.models.find((item) => item.id === value);
              setForm({ ...form, providerId: model?.providerId || form.providerId, model: value });
            }}
            options={providerModels.map((model) => ({ value: model.id, label: model.label, description: model.description }))}
          />
          <span className={styles.fieldHint}>{providerModels.find((model) => model.id === form.model)?.description}</span>
        </div>

        <div className={styles.field}>
          <SelectField
            label="Roleplay engine"
            value={form.roleplayPreset}
            onChange={(value) => setForm({ ...form, roleplayPreset: value as AppSettings["roleplayPreset"] })}
            options={catalog.engines.map((engine) => ({ value: engine.id, label: engine.label, description: engine.description }))}
          />
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

    <section className={styles.card} aria-labelledby="byok-heading">
      <div className={styles.cardHeader}><KeyRound size={16} aria-hidden /><h2 id="byok-heading">Bring your own API key</h2></div>
      <p className={styles.byokIntro}>
        Use your own OpenRouter credits for replies, regenerations and continuations. Afterglow still handles memory, continuity, Scene State and other background processing.
      </p>

      {!byok && <p className={styles.fieldHint} role="status">Checking OpenRouter connection…</p>}
      {byok && !byok.available && <div className={styles.byokUnavailable} role="status">
        Personal OpenRouter funding is not available on this deployment. Existing saved credentials remain encrypted and are not deleted.
      </div>}

      {byok?.available && <div className={styles.byokPanel}>
        <div className={styles.byokStatusRow}>
          <div className={styles.byokProviderMark}><ShieldCheck size={18} aria-hidden /></div>
          <div className={styles.byokStatusCopy}>
            <strong>OpenRouter</strong>
            <span>{byok.connected ? "Connected" : "Not connected"}</span>
            {byok.connected && <small>
              <span aria-label={`Key ending in ${byok.suffix}`}>•••••••• {byok.suffix}</span>
              {byok.validatedAt && <> · Validated {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(byok.validatedAt))}</>}
            </small>}
          </div>
        </div>

        {(!byok.connected || editingKey) && <div className={styles.byokConnect}>
          <label className={styles.fieldLabel} htmlFor="settings-openrouter-key">
            {byok.connected ? "Replacement OpenRouter key" : "OpenRouter API key"}
          </label>
          <input
            id="settings-openrouter-key"
            className={styles.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={byokKey}
            aria-describedby="settings-openrouter-key-help settings-openrouter-key-error"
            aria-invalid={Boolean(byokError)}
            onChange={(event) => setByokKey(event.target.value)}
            placeholder="sk-or-v1-…"
          />
          <span id="settings-openrouter-key-help" className={styles.fieldHint}>
            The key is sent once for validation, encrypted on the server, and never shown again.
          </span>
          <div className={styles.byokActions}>
            {editingKey && <button type="button" className={`${uiStyles.button} ${uiStyles.secondary}`} disabled={byokBusy} onClick={() => { setEditingKey(false); setByokKey(""); setByokError(""); }}>Cancel</button>}
            <button type="button" className={`${uiStyles.button} ${uiStyles.primary}`} disabled={byokBusy || !byokKey.trim()} onClick={() => void connectKey()}>
              {byokBusy ? "Validating…" : byok.connected ? "Validate replacement" : "Connect OpenRouter"}
            </button>
          </div>
        </div>}

        {byok.connected && !editingKey && <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Writer funding</span>
            <div className={styles.fundingChoices} role="radiogroup" aria-label="Writer funding">
              <button type="button" role="radio" aria-checked={byok.writerFunding === "afterglow"} disabled={byokBusy} onClick={() => void chooseFunding("afterglow")}>
                <strong>Afterglow</strong><small>Use Afterglow&apos;s writer funding</small>
              </button>
              <button type="button" role="radio" aria-checked={byok.writerFunding === "byok"} disabled={byokBusy} onClick={() => void chooseFunding("byok")}>
                <strong>My OpenRouter</strong><small>Use your connected credits</small>
              </button>
            </div>
          </div>
          <div className={styles.byokActions}>
            <button type="button" className={`${uiStyles.button} ${uiStyles.secondary}`} disabled={byokBusy} onClick={() => { setEditingKey(true); setConfirmRemove(false); }}>Replace key</button>
            <button type="button" className={`${uiStyles.button} ${uiStyles.destructive}`} disabled={byokBusy} onClick={() => setConfirmRemove(true)}>Remove key</button>
          </div>
        </>}

        {confirmRemove && <div className={styles.removeConfirm} role="group" aria-labelledby="remove-key-title" aria-describedby="remove-key-copy">
          <strong id="remove-key-title">Remove OpenRouter key?</strong>
          <p id="remove-key-copy">Your chats and memories will not be deleted. Writer funding will return to Afterglow.</p>
          <div className={styles.byokActions}>
            <button type="button" className={`${uiStyles.button} ${uiStyles.secondary}`} disabled={byokBusy} autoFocus onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button type="button" className={`${uiStyles.button} ${uiStyles.destructive}`} disabled={byokBusy} onClick={() => void removeKey()}>{byokBusy ? "Removing…" : "Remove key"}</button>
          </div>
        </div>}
      </div>}

      <p className={styles.byokDisclosure}>
        When enabled, roleplay generation requests are sent through your OpenRouter account. OpenRouter may expose request details according to your OpenRouter logging and privacy settings. Afterglow&apos;s memory and continuity processing continues through Afterglow infrastructure.
      </p>
      {byokError && <p id="settings-openrouter-key-error" className={styles.error} role="alert">{byokError}</p>}
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

      {/* Every figure in this card describes the selected window. A report
          whose parts cover different periods is worse than one that covers the
          wrong period, so the range is chosen once and applied to all of it. */}
      <div className={styles.rangePicker} role="group" aria-label="Reporting period">
        {usageRanges.map((option) => <button
          key={option.id}
          type="button"
          className={usageRange === option.id ? `${styles.rangeChip} ${styles.rangeChipActive}` : styles.rangeChip}
          aria-pressed={usageRange === option.id}
          onClick={() => setUsageRange(option.id)}
        >{option.label}</button>)}
      </div>
      {usageRange === "custom" && <div className={styles.rangeCustom}>
        <label className={styles.fieldLabel}>From<input className={styles.input} type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} /></label>
        <label className={styles.fieldLabel}>To<input className={styles.input} type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} /></label>
      </div>}
      <p className={styles.fieldHint} style={{ margin: "0 0 12px" }}>
        {usageLoading ? "Reading the ledger…" : `${usage.range?.label ?? "All time"} · ${number(usage.userMessages ?? 0)} user turns · ${number(usage.writerGenerations ?? 0)} writer generations`}
      </p>

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
          <dt>Inference value</dt>
          <dd>{usd(usage.usage.estimatedCostUsd)}</dd>
          <small>all funding sources</small>
        </div>
        <div className={styles.metric}>
          <dt>Afterglow spend</dt>
          <dd>{usd(usage.usage.afterglowCostUsd)}</dd>
          <small>{usd(usage.costPer100UserMessages || 0)} / 100 user turns</small>
        </div>
        {/* The other denominator: what producing a reply costs, counted from
            the ledger so a branch cannot inflate it. */}
        <div className={styles.metric}>
          <dt>Per generation</dt>
          <dd>{usd(usage.costPer100WriterGenerations || 0)}</dd>
          <small>/ 100 writer generations</small>
        </div>
        <div className={styles.metric}>
          <dt>My OpenRouter</dt>
          <dd>{usd(usage.usage.byokCostUsd)}</dd>
          <small>paid through your key</small>
        </div>
        {usage.usage.avgLatencyMs != null && <div className={styles.metric}>
          <dt>Latency</dt>
          <dd>{usage.usage.avgLatencyMs.toLocaleString()}<small> ms</small></dd>
          {usage.usage.avgTtftMs != null && <small>{usage.usage.avgTtftMs.toLocaleString()} ms to first token</small>}
        </div>}
      </dl>

      {usage.byFunding.length > 0 && <div className={styles.fundingBreakdown}>
        {usage.byFunding.map((item) => <div key={item.key}>
          <span>{item.key === "byok" ? "Paid through your OpenRouter key" : "Paid by Afterglow"}</span>
          <b>{usd(item.estimatedCostUsd)}</b>
        </div>)}
      </div>}

      <div className={styles.stack} style={{ marginTop: 14 }}>
        {usage.byType.map((item) => <div key={item.key} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
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
            {/* An upstream provider id has no break opportunity in it. */}
            <span className={styles.fieldHint} style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.key} · {item.requests} calls · {percent(item.cachedRatio)} cached</span>
            <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{usd(item.estimatedCostUsd)}</b>
          </div>)}
        </div>
      </div>}

      {/*
        * Estimated means estimated.
        *
        * OpenRouter reports the real charge for each generation and that figure
        * is used as-is. DeepSeek is billed direct and its price now depends on
        * when the request landed — the same tokens cost twice as much inside a
        * peak window as outside it — so a single number here is arithmetic, not
        * a bill. It is deliberately the PEAK figure: over-stating spend is
        * recoverable, under-stating it is the one that surprises somebody.
        */}
      <p className={styles.fieldHint} style={{ marginTop: 12 }}>
        Prices as of {usage.pricingAsOf}. Figures for models billed through OpenRouter are the charges it reported. Figures for DeepSeek are <b>estimated at its peak rate</b>, because its price depends on the time of day a request lands and the actual split is not reported per request — off-peak requests cost about half as much, so real spend sits at or below what is shown.
      </p>
      <p className={styles.fieldHint}>
        Cached input is charged at a fraction of fresh input, so a high cache hit rate on a long conversation is where the saving is.
      </p>

      {/*
        * ROUTING & CACHE AFFINITY.
        *
        * The breakdown above sums across every conversation at once, which
        * means it looks exactly the same whether ONE story bounced between
        * four upstream hosts — paying fresh-input prices to re-read a prompt
        * it had already sent — or FOUR stories each settled on a host and
        * stayed warm. Those need opposite responses, so this panel asks the
        * question per conversation instead of per account.
        */}
      {routing && <div style={{ marginTop: 18 }}>
        <span className={styles.fieldLabel}>Routing &amp; cache affinity</span>
        <p className={styles.fieldHint} style={{ marginTop: 4 }}>
          Routing mode <b>{routing.routing.mode}</b>
          {routing.routing.emergencyExpensiveFallback ? " · emergency expensive fallback ARMED" : ""}
          {routing.truncated ? " · window truncated, narrow the range" : ""}
        </p>
        {/*
          * WHAT IS GUARDING EACH MODEL, beside what it produced.
          *
          * Only the guarded models are listed: a row saying "no ceiling, no
          * pool, not fundable" for every unguarded writer would bury the four
          * that matter. The pool is shown because a price ceiling alone does
          * not guarantee an endpoint discounts cache reads, and cached reads
          * are most of what a long story pays for.
          */}
        {routing.routing.guards?.some((guard) => guard.maxPrice || guard.enforcedPool) && <ul className={styles.fieldHint} style={{ margin: "4px 0 0", paddingLeft: 16 }}>
          {routing.routing.guards.filter((guard) => guard.maxPrice || guard.enforcedPool).map((guard) => <li key={guard.modelId}>
            <b>{guard.modelId}</b>
            {guard.maxPrice ? ` · ceiling $${guard.maxPrice.prompt}/M in, $${guard.maxPrice.completion}/M out` : ""}
            {guard.enforcedPool ? ` · pool ${guard.enforcedPool.join(", ")}` : " · pool advisory"}
            {guard.dataPolicy ? ` · ${guard.dataPolicy.dataCollection === "deny" ? "no training" : "training allowed"}` : ""}
            {guard.fundable ? " · platform-fundable" : ""}
          </li>)}
        </ul>}

        {routing.drift.eligibleConversations > 0
          ? <p className={styles.fieldHint}>
              {routing.drift.driftedConversations === 0
                ? <>No provider drift: all {routing.drift.eligibleConversations} conversations with {routing.drift.minimumGenerations}+ generations stayed on one upstream host.</>
                : <><b>{routing.drift.driftedConversations} of {routing.drift.eligibleConversations}</b> conversations changed upstream host mid-story ({routing.drift.totalSwitches} switches). Every switch is a cold prefix billed at the fresh rate.</>}
            </p>
          : <p className={styles.fieldHint}>Not enough writer generations in this range to say whether anything drifted.</p>}

        <div className={styles.stack} style={{ marginTop: 8 }}>
          {routing.byProvider.map((item) => <div key={item.provider} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <strong style={{ fontSize: 13 }}>{item.provider}</strong>
              <br />
              <small className={styles.fieldHint}>
                {item.generations} gens across {item.conversations} chats · {percent(item.cacheRatio)} cached
                {item.effectiveInputUsdPerMillion != null ? ` · $${item.effectiveInputUsdPerMillion.toFixed(3)}/M effective in` : ""}
                {item.reasoningTokens > 0 ? ` · ${number(item.reasoningTokens)} reasoning tokens` : ""}
                {item.avgTtftMs != null ? ` · ${item.avgTtftMs.toLocaleString()}ms to first token` : ""}
              </small>
            </span>
            <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
              {item.costPer100Generations != null ? `${usd(item.costPer100Generations)} / 100` : "—"}
            </b>
          </div>)}
        </div>

        {routing.drift.worst.length > 0 && <div style={{ marginTop: 10 }}>
          <small className={styles.fieldHint}>
            Most-switched conversations: {routing.drift.worst.map((item) => `${item.conversationId.slice(0, 8)} (${item.providerSwitches} switches over ${item.generations} gens, ${percent(item.cacheRatio)} cached)`).join(" · ")}
          </small>
        </div>}

        <p className={styles.fieldHint} style={{ marginTop: 8 }}>
          Effective input $/M is <b>derived</b>: the charge OpenRouter reported, less the output half priced at the endpoint&rsquo;s list rate. Cache ratio and cost are measured. An endpoint with no known list price shows no effective rate rather than a guess.
        </p>
      </div>}
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
