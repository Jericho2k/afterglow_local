#!/usr/bin/env node
/**
 * WHICH CONSTRAINT TURNS A WORKING REQUEST INTO A FAILING ONE.
 *
 * Production sends more than a model id. It sends a price ceiling, an approved
 * provider pool, a data-collection floor, a reasoning setting and a session
 * hint, and it sends them together — so when a model starts failing, "the
 * provider is broken" and "one of our five constraints excludes every endpoint
 * that serves it" look identical from the outside. Both arrive as a 400 or a
 * 404 with a sentence the reader is not allowed to see.
 *
 * This adds them ONE AT A TIME and prints where the first failure appears.
 * That is the whole design: the answer is a boundary, not a verdict, and a run
 * that succeeds all the way through is as useful as one that does not — it
 * rules the request policy out and points at the provider.
 *
 * ARMS (§1.6 of the sprint brief)
 *   A  model only                              the control
 *   B  + the catalogue's reasoning setting     off, on, or an effort level
 *   C  + data_collection: deny                 the privacy floor
 *   D  + max_price                             the cost ceiling
 *   E  + provider.only                         the approved pool
 *   F  + provider.order                        the serving-profile preference
 *   G  exactly what production builds          every one of them together
 *
 * Each arm is the previous arm plus one thing, so the FIRST arm that fails
 * names the constraint that did it. Arm G is built by the app's own
 * `providerPolicyFor`, not by this file, so a policy change cannot make the
 * bisect and production disagree.
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/provider-constraint-bisect.mjs
 *   … --model glm-5.3-flash          an Afterglow catalogue id (default)
 *   … --models glm-5.3-flash,glm-4.7
 *   … --stream                       ask for a streamed response, as chat does
 *   … --max-tokens 64                the reply is not the point (default 48)
 *   … --json                         machine-readable rows
 *
 * WHAT IT REPORTS. For every arm: the HTTP status, the upstream host that
 * answered, the request id, the latency, whether any prose came back, the
 * finish reason, and a trimmed upstream body. No prompt content is printed
 * beyond the fixed synthetic turn below, and the key is never echoed.
 *
 * WHY A SCRIPT. It spends money against a live endpoint, which cannot happen in
 * CI. The half that CAN be checked offline — that the policy object is built
 * correctly, that a relayed capability rejection is retried elsewhere and a
 * malformed request is not — is in tests/glm-cost-routing.test.ts and
 * tests/provider-incompatibility.test.ts.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required: this script measures a live endpoint on purpose.");
  process.exit(1);
}

/*
 * THE CATALOGUE, MIRRORED — AND PINNED BY A TEST.
 *
 * `src/lib/provider.ts` cannot be imported here: it pulls in the rest of the
 * app's module graph, and this script has to run from a plain Node with no
 * build step. Mirroring it by hand is the same choice
 * `scripts/glm-routing-benchmark.mjs` made, and it has the same hazard — a
 * mirror that drifts measures a policy nobody ships.
 *
 * So the mirror is machine-checked. `tests/provider-incompatibility.test.ts`
 * parses this object and compares every field against the catalogue, and fails
 * the build if they disagree. Adding a model here without adding it there is
 * therefore a failing test rather than a misleading run.
 */
export const constraints = {
  "glm-5.3-flash": {
    upstreamModel: "z-ai/glm-5.3-flash",
    // An effort level, not "off": this endpoint answers `{ enabled: false }`
    // with 400 "Reasoning is mandatory for this endpoint and cannot be
    // disabled", so "off" was never a setting production could send.
    reasoning: "low",
    dataCollection: "deny",
    zdr: false,
    maxPrice: { prompt: 0.20, completion: 0.60 },
    only: ["z-ai"],
    order: [],
    // Dedicated: one host, fallbacks off. Arm E and arm G both say so, which is
    // the difference between "prefer these" and "this or nothing" — and the
    // whole reason a Z.AI outage must read as a failure rather than as a
    // quietly different writer.
    allowFallbacks: false,
  },
  "glm-4.7": {
    upstreamModel: "z-ai/glm-4.7",
    reasoning: null,
    dataCollection: "deny",
    zdr: false,
    maxPrice: { prompt: 0.65, completion: 2.25 },
    only: ["deepinfra", "novita", "z-ai"],
    order: [],
    allowFallbacks: true,
  },
};

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const catalogueIds = (option("models", option("model", "glm-5.3-flash"))).split(",").map((value) => value.trim()).filter(Boolean);
const maxTokens = Number(option("max-tokens", "48"));
const streamed = flag("stream");

/**
 * The `reasoning` block for one declared setting, in the adapter's own shapes.
 *
 * Three of them, because the catalogue has three answers and an arm that sent
 * the wrong shape would measure a request production does not build:
 * `{enabled:true}` asks for reasoning, `{enabled:false}` declines it, and an
 * effort level asks for it and says how much — the only "less, but not none"
 * an endpoint that mandates reasoning will accept. Mirrors `commonFields` in
 * src/lib/openrouter.ts.
 */
function reasoningBody(setting) {
  if (!setting) return {};
  if (setting === "on") return { reasoning: { enabled: true } };
  if (setting === "off") return { reasoning: { enabled: false } };
  return { reasoning: { effort: setting } };
}

/** One fixed, synthetic turn. Nothing here reads anybody's story. */
const messages = [
  { role: "system", content: "You are a writer in a fictional scene. Answer in one short paragraph." },
  { role: "user", content: "She sets the lantern down on the table. What happens next?" },
];

/**
 * The arms, cumulative.
 *
 * Everything but G is assembled here rather than by the app, deliberately: the
 * point is to isolate ONE constraint at a time, which the app never does. G
 * asks the app for the real thing, so the last arm and production cannot drift
 * apart.
 */
function armsFor(catalogueId) {
  const model = constraints[catalogueId];
  const arms = [
    { id: "A", label: "model only", body: {} },
    {
      id: "B",
      label: `+ reasoning ${model.reasoning ?? "(model declares none — arm skipped)"}`,
      skip: !model.reasoning,
      body: reasoningBody(model.reasoning),
    },
    {
      id: "C",
      label: `+ data_collection: ${model.dataCollection ?? "(none declared)"}`,
      skip: !model.dataCollection,
      body: { provider: { data_collection: model.dataCollection, ...(model.zdr ? { zdr: true } : {}) } },
    },
    {
      id: "D",
      label: `+ max_price ${model.maxPrice.prompt}/${model.maxPrice.completion}`,
      body: { provider: { max_price: model.maxPrice } },
    },
    {
      id: "E",
      label: `+ provider.only [${model.only.join(", ") || "none"}]${model.allowFallbacks ? "" : " (fallbacks off)"}`,
      skip: !model.only.length,
      body: { provider: { only: model.only, allow_fallbacks: model.allowFallbacks } },
    },
    {
      id: "F",
      label: `+ provider.order [${model.order.join(", ") || "none — arm skipped"}]`,
      skip: !model.order.length,
      body: { provider: { order: model.order, allow_fallbacks: true } },
    },
    {
      /*
       * Production's first attempt, as src/lib/provider.ts assembles it: the
       * preferred order where a model declares one, the approved pool or the
       * one dedicated host, the ceiling, the privacy floor, fallbacks as the
       * catalogue sets them, no `sort`, plus the conversation-scoped session
       * hint the chat route sends.
       */
      id: "G",
      label: "exactly what production sends",
      body: {
        ...reasoningBody(model.reasoning),
        provider: {
          ...(model.order.length ? { order: model.order } : {}),
          ...(model.only.length ? { only: model.only } : {}),
          allow_fallbacks: model.allowFallbacks,
          max_price: model.maxPrice,
          data_collection: model.dataCollection,
          ...(model.zdr ? { zdr: true } : {}),
        },
        session_id: `bisect-${catalogueId}`,
      },
    },
  ];

  // Cumulative: each arm carries everything the arms before it added, so the
  // FIRST failing arm names the constraint that did it.
  let accumulated = {};
  return arms.map((arm) => {
    if (arm.skip || arm.id === "G") return arm;
    accumulated = mergeBody(accumulated, arm.body);
    return { ...arm, body: structuredClone(accumulated) };
  });
}

function mergeBody(base, addition) {
  return {
    ...base, ...addition,
    ...(base.provider || addition.provider ? { provider: { ...base.provider, ...addition.provider } } : {}),
  };
}

async function ask(upstreamModel, arm) {
  const startedAt = Date.now();
  const body = {
    model: upstreamModel,
    messages,
    max_tokens: maxTokens,
    temperature: 0.9,
    usage: { include: true },
    ...(streamed ? { stream: true } : {}),
    ...arm.body,
  };
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow constraint bisect" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, detail: String(error).slice(0, 240), latencyMs: Date.now() - startedAt };
  }
  const latencyMs = Date.now() - startedAt;
  const requestId = response.headers.get("x-request-id") ?? "";
  const upstreamProvider = response.headers.get("x-openrouter-provider") ?? "";
  if (!response.ok) {
    return { ok: false, status: response.status, requestId, upstreamProvider, latencyMs, detail: (await response.text()).slice(0, 300) };
  }
  if (streamed) {
    const text = await response.text();
    const frames = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    let prose = ""; let finish = ""; let provider = upstreamProvider; let id = requestId;
    for (const frame of frames) {
      if (!frame || frame === "[DONE]") continue;
      try {
        const parsed = JSON.parse(frame);
        prose += parsed.choices?.[0]?.delta?.content ?? "";
        finish = parsed.choices?.[0]?.finish_reason ?? finish;
        provider = parsed.provider ?? provider;
        id = parsed.id ?? id;
      } catch { /* a frame this script could not read is reported as a count */ }
    }
    return { ok: Boolean(prose.trim()), status: 200, requestId: id, upstreamProvider: provider, latencyMs, characters: prose.length, finish };
  }
  const data = await response.json();
  const prose = data.choices?.[0]?.message?.content ?? "";
  return {
    ok: Boolean(prose.trim()),
    status: 200,
    requestId: data.id ?? requestId,
    upstreamProvider: data.provider ?? upstreamProvider,
    latencyMs,
    characters: prose.length,
    finish: data.choices?.[0]?.finish_reason ?? "",
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

const rows = [];
for (const catalogueId of catalogueIds) {
  if (!constraints[catalogueId]) {
    console.error(`${catalogueId} is not mirrored in this script. Add it to \`constraints\` above; tests/provider-incompatibility.test.ts will check it against the catalogue.`);
    continue;
  }
  const upstreamModel = constraints[catalogueId].upstreamModel;
  console.log(`\n${catalogueId}  →  ${upstreamModel}${streamed ? "  (streamed)" : ""}`);
  console.log("arm  constraint                                          status  host          ms     chars  finish");
  let firstFailure = null;
  for (const arm of armsFor(catalogueId)) {
    if (arm.skip) {
      console.log(`${arm.id}    ${arm.label.padEnd(50)}  skipped`);
      continue;
    }
    const result = await ask(upstreamModel, arm);
    rows.push({ model: catalogueId, arm: arm.id, label: arm.label, ...result });
    console.log([
      `${arm.id}    `, arm.label.padEnd(50), "  ",
      String(result.status).padStart(6), "  ",
      (result.upstreamProvider || "—").padEnd(12), " ",
      String(result.latencyMs).padStart(6), " ",
      String(result.characters ?? 0).padStart(6), "  ",
      result.ok ? (result.finish || "stop") : "FAILED",
    ].join(""));
    if (!result.ok && result.detail) console.log(`       ${result.detail.replace(/\s+/g, " ").slice(0, 160)}`);
    if (!result.ok && !firstFailure) firstFailure = arm;
  }
  console.log(firstFailure
    ? `\n  FIRST FAILING CONSTRAINT: ${firstFailure.id} — ${firstFailure.label}`
    : "\n  Every constraint held. The request policy is not what is failing.");
}

if (flag("json")) console.log(`\n${JSON.stringify(rows, null, 2)}`);
