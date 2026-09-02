/* ============================================================
   refresh.js — scheduled price-refresh pipeline (no dependencies)

   Pipeline:
     1. Scrape BenchLM.ai pricing table (__NEXT_DATA__ JSON)      → base dataset
     2. Scrape official provider pricing docs:
          Z.AI     (docs.z.ai/...pricing.md  — clean markdown)
          DeepSeek (api-docs.deepseek.com    — HTML, peak rates)
     3. Merge data/overrides.json (verified static fallbacks;
        live parser results win per-model when they succeed)
     4. Diff against current dataset → rewrite data/models.js atomically
     5. Write data/last-refresh.json + return a change summary

   Called by the /api/refresh endpoint in server.js — safe to run on a cron.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const MODELS_PATH = path.join(DATA_DIR, "models.js");
const OVERRIDES_PATH = path.join(DATA_DIR, "overrides.json");
const LASTREFRESH_PATH = path.join(DATA_DIR, "last-refresh.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const BENCHLM_URL = "https://benchlm.ai/llm-pricing";
const ZAI_PRICING_URL = "https://docs.z.ai/guides/overview/pricing.md";
const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const CREATORS_RENAME = { "Mistral AI": "Mistral" };

/* ---------------- helpers ---------------- */

async function fetchText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,text/plain,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const trimZeros = (s) => String(s).replace(/\.?0+$/, "");
const fmtCtx = (n) => {
  if (!n) return null;
  if (n >= 1_000_000) return trimZeros((n / 1_000_000).toFixed(2)) + "M";
  if (n >= 1000) return trimZeros((n / 1000).toFixed(2)) + "K";
  return String(n);
};

function htmlToText(raw) {
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "|")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\|+/g, " | ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/* ---------------- source 1: BenchLM ---------------- */

async function scrapeBenchLM() {
  const html = await fetchText(BENCHLM_URL);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("BenchLM: __NEXT_DATA__ block not found (page structure changed?)");
  const data = JSON.parse(m[1]);
  const raw = data?.props?.pageProps?.pricingPageData;
  if (!raw || !Array.isArray(raw.models)) throw new Error("BenchLM: pricingPageData.models missing");

  const models = [];
  for (const r of raw.models) {
    const priced = r.inputPrice != null || r.outputPrice != null;
    const openw = r.sourceType === "Open Weight";
    if (!priced && !openw) continue;
    models.push({
      id: r.slug,
      provider: CREATORS_RENAME[r.creator] || r.creator,
      name: r.model,
      variant: r.variantType || null,
      input: r.inputPrice,
      cached: r.cachedInputPrice,
      output: r.outputPrice,
      ctx: fmtCtx(r.contextSize),
      ctxTok: r.contextSize || null,
      type: r.sourceType || "Unknown",
      score: r.overallScore ?? null,
      url: `https://benchlm.ai/models/${r.slug}`,
      free: false,
      note: null,
    });
  }
  return { models, meta: { period: raw.pagePeriodLabel || null, lastUpdated: raw.lastUpdated || null } };
}

/* ---------------- source 2: Z.AI official docs (markdown) ---------------- */

const ZAI_SLUG = {
  "GLM-5.3-Flash": "glm-5-3-flash", "GLM-5.3": "glm-5-3", "GLM-5.2": "glm-5-2",
  "GLM-5.1": "glm-5-1", "GLM-5": "glm-5", "GLM-4.7": "glm-4-7",
  "GLM-4.7-Flash": "glm-4-7-flash", "GLM-4.7-FlashX": "glm-4-7-flashx",
  "GLM-4.6": "glm-4-6", "GLM-4.5": "glm-4-5", "GLM-4.5-X": "glm-4-5-x",
  "GLM-4.5-Air": "glm-4-5-air", "GLM-4.5-AirX": "glm-4-5-airx",
  "GLM-4.6V": "glm-4-6v", "GLM-4.5V": "glm-4-5v", "GLM-OCR": "glm-ocr",
};

function parsePriceCell(cell) {
  // "~~\$0.15~~ \$0.075" → { current: 0.075, list: 0.15 }   (strikethrough = list)
  // "\$1.4"             → { current: 1.4, list: null }
  // "Free"              → { current: 0, list: null, free: true }
  const clean = cell.replace(/\\/g, "").trim();
  if (/^Free$/i.test(clean)) return { current: 0, list: null, free: true };
  const nums = [...clean.matchAll(/([0-9]+(?:\.[0-9]+)?)/g)].map((m) => parseFloat(m[1]));
  if (!nums.length) return null;
  const struck = /~~/.test(clean);
  return struck
    ? { current: nums[nums.length - 1], list: nums[0] }
    : { current: nums[0], list: null };
}

async function scrapeZAI() {
  const md = await fetchText(ZAI_PRICING_URL);
  const overrides = {};
  const notes = [];
  let promoSeen = false;

  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const slug = ZAI_SLUG[cells[1]];
    if (!slug) continue;

    const inP = parsePriceCell(cells[2]);
    const caP = parsePriceCell(cells[3]);
    const outP = parsePriceCell(cells[5] ?? cells[4]);
    if (!inP || !outP) continue;

    const free = !!(inP.free && outP.free);
    const promo = !!(inP.list != null && inP.list !== inP.current);
    if (promo) promoSeen = true;

    overrides[slug] = {
      input: inP.current,
      cached: caP ? caP.current : null,
      output: outP.current,
      free,
      note: free
        ? "Genuinely free first-party API (Z.AI docs)"
        : promo
          ? `Z.AI 50% promo price — list $${inP.list.toFixed(2)}/$${outP.list.toFixed(2)}; verify at docs.z.ai`
          : "Verified from Z.AI official docs",
      source: "Z.AI docs",
    };
    notes.push(`${cells[1]}: $${inP.current}/$${outP.current}${promo ? " (promo)" : ""}${free ? " FREE" : ""}`);
  }
  if (!Object.keys(overrides).length) throw new Error("Z.AI: no model rows parsed");
  if (promoSeen) notes.push("GLM-5.3-Flash promo ends Sep 9, 2026 (UTC+8)");
  return { overrides, notes, url: "https://docs.z.ai/guides/overview/pricing" };
}

/* ---------------- source 3: DeepSeek official docs (HTML) ---------------- */

async function scrapeDeepSeek() {
  const text = htmlToText(await fetchText(DEEPSEEK_PRICING_URL));
  // grab BOTH tiers: "… 1M OUTPUT TOKENS | OFF-PEAK | $0.66 | $1.98 | $0.66 | PEAK | $1.32 | $3.96 | $1.32 …"
  // anchors are pipe-prefixed so "PEAK" inside "OFF-PEAK" can't confuse the match
  const grab = (label) => {
    const re = new RegExp(
      label +
      "[\\s\\S]*?\\| OFF-PEAK \\| \\$([0-9.]+) \\| \\$([0-9.]+) \\| \\$([0-9.]+)" +
      " \\| PEAK \\| \\$([0-9.]+) \\| \\$([0-9.]+) \\| \\$([0-9.]+)"
    );
    const m = text.match(re);
    if (!m) throw new Error(`DeepSeek: cannot locate "${label}" tier rows`);
    const n = m.slice(1).map(parseFloat);
    // column order on the docs page: v4-flash, v4-pro, v4-flash-vision-exp
    return { off: { flash: n[0], pro: n[1], vision: n[2] }, peak: { flash: n[3], pro: n[4], vision: n[5] } };
  };
  const inMiss = grab("1M INPUT TOKENS \\| \\(CACHE MISS\\)");
  const out = grab("1M OUTPUT TOKENS");
  const inHit = grab("1M INPUT TOKENS \\| \\(CACHE HIT\\)");

  const TIERS = { tz: "UTC", peakHours: [[1, 4], [6, 10]], peakDays: [1, 2, 3, 4, 5] };
  const NOTE = "Time-tiered API pricing — app shows the rate effective right now. Peak hours 01:00–04:00 & 06:00–10:00 UTC, Mon–Fri; off-peak is half. Verified from DeepSeek official docs";

  const overrides = {
    "deepseek-v4-flash-0731": {
      input: inMiss.peak.flash, cached: inHit.peak.flash, output: out.peak.flash,
      timeTiers: { ...TIERS, offPeak: { input: inMiss.off.flash, cached: inHit.off.flash, output: out.off.flash } },
      note: NOTE, source: "DeepSeek docs",
    },
    "deepseek-v4-pro-0813": {
      input: inMiss.peak.pro, cached: inHit.peak.pro, output: out.peak.pro,
      timeTiers: { ...TIERS, offPeak: { input: inMiss.off.pro, cached: inHit.off.pro, output: out.off.pro } },
      note: NOTE, source: "DeepSeek docs",
    },
  };
  const notes = [
    `v4-flash peak $${inMiss.peak.flash}/$${out.peak.flash} · off-peak $${inMiss.off.flash}/$${out.off.flash}`,
    `v4-pro peak $${inMiss.peak.pro}/$${out.peak.pro} · off-peak $${inMiss.off.pro}/$${out.off.pro}`,
  ];
  return { overrides, notes, url: DEEPSEEK_PRICING_URL };
}

/* ---------------- static fallback overrides ---------------- */

function loadStaticOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
  } catch {
    return { bySlug: {}, nullPrices: [] };
  }
}

/* ---------------- merging & diffing ---------------- */

function applyOverrides(models, ov) {
  let applied = 0;
  const byId = new Map(models.map((m) => [m.id, m]));

  for (const [slug, patch] of Object.entries(ov.bySlug || {})) {
    const m = byId.get(slug);
    if (!m) continue;
    for (const k of ["input", "cached", "output", "type", "ctx", "ctxTok", "timeTiers"]) {
      if (patch[k] !== undefined) m[k] = patch[k];
    }
    if (patch.free !== undefined) m.free = patch.free;
    if (patch.deprecated !== undefined) m.deprecated = patch.deprecated;
    if (patch.note) m.note = patch.note;
    applied++;
  }
  for (const slug of ov.nullPrices || []) {
    const m = byId.get(slug);
    if (!m) continue;
    m.input = m.cached = m.output = null;
    m.deprecated = true;
    m.note = "Deprecated / no longer listed by provider";
    applied++;
  }
  // addModels: curated rows missing from the base scrape (brand-new models etc.).
  // If the base scrape later gains the same id, the override patches it instead of duplicating.
  for (const rec of ov.addModels || []) {
    const existing = byId.get(rec.id);
    if (existing) {
      for (const k of ["input", "cached", "output", "type", "ctx", "ctxTok", "free", "note", "score"]) {
        if (rec[k] !== undefined) existing[k] = rec[k];
      }
    } else {
      const rec2 = {
        variant: null, ctx: null, ctxTok: null, type: "Proprietary",
        score: null, free: false, note: null, ...rec,
      };
      models.push(rec2);
      byId.set(rec.id, rec2);
    }
    applied++;
  }
  return applied;
}

function diffModels(oldList, newList) {
  if (!oldList) return [];
  const oldById = new Map(oldList.map((m) => [m.id, m]));
  const changes = [];
  for (const m of newList) {
    const o = oldById.get(m.id);
    if (!o) { changes.push({ id: m.id, change: "added" }); continue; }
    for (const k of ["input", "cached", "output"]) {
      if ((o[k] ?? null) !== (m[k] ?? null)) {
        changes.push({ id: m.id, field: k, from: o[k] ?? null, to: m[k] ?? null });
      }
    }
  }
  for (const o of oldList) if (!newList.some((m) => m.id === o.id)) changes.push({ id: o.id, change: "removed" });
  return changes;
}

/* ---------------- validation gate ----------------
   Runs BEFORE writing. errors → abort the refresh (old data kept);
   warnings/suspicious → write anyway but surface in the summary for review. */
function validateModels(models, prevModels) {
  const errors = [], warnings = [], suspicious = [];

  if (!Array.isArray(models) || models.length === 0) {
    errors.push("dataset is empty or malformed — refusing to write");
    return { errors, warnings, suspicious };
  }

  const prevById = new Map((prevModels || []).map((m) => [m.id, m]));

  // structural cliff = the base page probably changed shape
  if (prevModels && prevModels.length && models.length < prevModels.length * 0.8) {
    errors.push(`model count dropped ${prevModels.length} → ${models.length} (>20%); possible scrape breakage`);
  }

  for (const m of models) {
    const label = `${m.provider}/${m.name}`;
    for (const k of ["input", "cached", "output"]) {
      const v = m[k];
      if (v != null && (typeof v !== "number" || !isFinite(v) || v < 0)) {
        errors.push(`${label}: ${k} must be a non-negative number, got ${JSON.stringify(v)}`);
      }
    }
    if (m.input != null && m.output != null && !m.free && !(m.input === 0 && m.output === 0)) {
      // sanity ratios observed across chat/market: output ≈ 1×–8× input.
      // speech/audio models bill "output" as audio tokens — the heuristic doesn't apply.
      const isSpeech = /tts|audio|realtime|speech|\basr\b|voice|\bstt\b|transcri/i.test(m.name) ||
        ["ElevenLabs", "Cartesia", "Deepgram", "Kyutai"].includes(m.provider);
      if (!isSpeech) {
        const ratio = m.output / Math.max(m.input, 1e-9);
        if (ratio > 10) warnings.push(`${label}: output/input ratio ${ratio.toFixed(1)}× is unusually high`);
        if (ratio < 0.4) warnings.push(`${label}: output/input ratio ${ratio.toFixed(2)}× is unusually low`);
      }
    }
    if (m.cached != null && m.input != null && m.input > 0 && m.cached > m.input) {
      warnings.push(`${label}: cached-input ($${m.cached}) exceeds input ($${m.input})`);
    }
    if (m.timeTiers) {
      const t = m.timeTiers;
      if (!t.offPeak || t.offPeak.input == null) {
        warnings.push(`${label}: timeTiers present but offPeak rates missing`);
      } else {
        for (const k of ["input", "output"]) {
          if (t.offPeak[k] != null && m[k] != null && t.offPeak[k] > m[k]) {
            warnings.push(`${label}: off-peak ${k} ($${t.offPeak[k]}) exceeds peak ($${m[k]}) — tier data looks inverted`);
          }
        }
      }
    }

    // drift vs previous snapshot: flag big moves for human confirmation
    const prev = prevById.get(m.id);
    if (prev) {
      for (const k of ["input", "output"]) {
        const a = prev[k], b = m[k];
        if (a != null && b != null && a > 0 && b > 0) {
          const rel = Math.abs(b - a) / Math.min(a, b);
          if (rel >= 0.5 && Math.abs(b - a) >= 0.05) {
            suspicious.push({ id: m.id, model: label, field: k, from: a, to: b, pct: Math.round(rel * 100) });
          }
        } else if ((a == null) !== (b == null)) {
          suspicious.push({ id: m.id, model: label, field: k, from: a ?? null, to: b ?? null, pct: null, note: "price appeared/disappeared" });
        }
      }
    }
  }
  return { errors, warnings, suspicious };
}

/* ---------------- file generation ---------------- */

function generateModelsJs(models, meta, sourceList) {
  const header = `// AI model pricing dataset — regenerated by refresh.js on ${todayISO()}
// Base: BenchLM.ai pricing table (period ${meta.period || "n/a"}, provider lastUpdated ${meta.lastUpdated || "n/a"})
// Corrected against official provider docs where parsers succeeded (see sources).
// All prices USD per 1M tokens.
//   free:true                        → genuinely free first-party API ($0 is real)
//   input/output 0 without free:true → open weights, no first-party API rate ("self-host")
//   null price                       → no reliable rate in dataset
// Manual corrections: edit data/overrides.json, then call /api/refresh.
const AI_MODELS_DATA = {
  asOf: ${JSON.stringify(todayISO())},
  period: ${JSON.stringify(meta.period || todayISO())},
  benchlmLastUpdated: ${JSON.stringify(meta.lastUpdated || null)},
  sources: [
    ${sourceList.map((s) => JSON.stringify(s)).join(",\n    ")}
  ],
  models: [
`;
  const rows = models.map((m) => "    " + JSON.stringify(m));
  return header + rows.join(",\n") + "\n  ]\n};\n" +
    'if (typeof window !== "undefined") window.AI_MODELS = AI_MODELS_DATA;\n' +
    'if (typeof module !== "undefined") module.exports = AI_MODELS_DATA;\n';
}

/* ---------------- main pipeline ---------------- */

let running = null; // concurrency guard

async function runRefresh(reason = "manual", opts = {}) {
  const dryRun = !!opts.dryRun;
  if (running) throw Object.assign(new Error("Refresh already in progress"), { code: "ALREADY_RUNNING" });
  running = (async () => {
    const startedAt = new Date().toISOString();
    const log = [];

    // 1) BenchLM base
    const bench = await scrapeBenchLM();
    log.push(`BenchLM OK: ${bench.models.length} models (period ${bench.meta.period}, provider lastUpdated ${bench.meta.lastUpdated})`);
    let models = bench.models;

    // 2) provider doc parsers (tolerated failures)
    const providerSources = [];
    const dynamicOverrides = {};
    const parsers = {};
    for (const [name, fn] of [["zai", scrapeZAI], ["deepseek", scrapeDeepSeek]]) {
      try {
        const r = await fn();
        Object.assign(dynamicOverrides, r.overrides);
        parsers[name] = { ok: true, models: Object.keys(r.overrides).length, notes: r.notes };
        providerSources.push({
          name: name === "zai" ? "Z.AI official pricing docs" : "DeepSeek official pricing docs",
          url: r.url,
        });
        log.push(`${name} OK: ${r.notes.join("; ")}`);
      } catch (e) {
        parsers[name] = { ok: false, error: String(e.message || e) };
        log.push(`${name} FAILED: ${e.message} — using static overrides for coverage`);
      }
    }

    // 3) merge: static fallback first, live parser results win per model
    const stat = loadStaticOverrides();
    const bySlug = { ...(stat.bySlug || {}) };
    for (const [slug, patch] of Object.entries(dynamicOverrides)) {
      bySlug[slug] = { ...(bySlug[slug] || {}), ...patch };
    }

    // 4) apply + write atomically (with backup)
    const before = safeReadModels();
    const applied = applyOverrides(models, {
      bySlug,
      nullPrices: stat.nullPrices || [],
      addModels: stat.addModels || [],
    });

    models = models.filter((m) => m.input != null || m.output != null || m.type === "Open Weight");
    models.sort((a, b) =>
      a.provider.toLowerCase().localeCompare(b.provider.toLowerCase()) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const changes = diffModels(before, models);

    // ---- validation gate (before any write) ----
    const validation = validateModels(models, before);
    if (validation.errors.length) {
      const summary = {
        ok: false,
        reason: reason + (dryRun ? " (dry-run)" : ""),
        startedAt,
        finishedAt: new Date().toISOString(),
        dryRun,
        aborted: true,
        validation,
        changes,
        log: [...log, `VALIDATION FAILED — ${dryRun ? "nothing to write" : "existing dataset kept untouched"}`],
      };
      if (!dryRun) {
        try { fs.writeFileSync(LASTREFRESH_PATH, JSON.stringify({ ...lastRefreshSummary(), ...summary }, null, 2)); } catch {}
      }
      return summary;
    }

    const sources = [
      { name: "BenchLM.ai LLM pricing table", url: BENCHLM_URL },
      ...providerSources,
      { name: "FutureAGI LLM cost calculators", url: "https://futureagi.com/llm-cost-calculator" },
      { name: "LLM-Stats model pages", url: "https://llm-stats.com" },
    ];

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        asOf: todayISO(),
        models: models.length,
        priced: models.filter((m) => m.input != null && !(m.input === 0 && m.output === 0 && !m.free)).length,
        free: models.filter((m) => m.free).length,
        overridesApplied: applied,
        parsers,
        validation,
        changes,
        log,
      };
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(MODELS_PATH)) {
      fs.copyFileSync(MODELS_PATH, path.join(BACKUP_DIR, `models-${Date.now()}.js`));
      const backups = fs.readdirSync(BACKUP_DIR).sort();
      while (backups.length > 5) fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
    }
    const tmp = MODELS_PATH + ".tmp";
    fs.writeFileSync(tmp, generateModelsJs(models, bench.meta, sources));
    fs.renameSync(tmp, MODELS_PATH);

    const summary = {
      ok: true,
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt),
      asOf: todayISO(),
      models: models.length,
      priced: models.filter((m) => m.input != null && !(m.input === 0 && m.output === 0 && !m.free)).length,
      free: models.filter((m) => m.free).length,
      overridesApplied: applied,
      parsers,
      validation,
      changes,
      log,
    };
    fs.writeFileSync(LASTREFRESH_PATH, JSON.stringify(summary, null, 2));
    return summary;
  })();

  try {
    return await running;
  } catch (e) {
    // persist the failure too, so health checks can see it
    const err = { ok: false, error: String(e.message || e), at: new Date().toISOString() };
    try { fs.writeFileSync(LASTREFRESH_PATH, JSON.stringify({ ...lastRefreshSummary(), ...err }, null, 2)); } catch {}
    throw e;
  } finally {
    running = null;
  }
}

function lastRefreshSummary() {
  try { return JSON.parse(fs.readFileSync(LASTREFRESH_PATH, "utf8")); } catch { return null; }
}

function safeReadModels() {
  try {
    const src = fs.readFileSync(MODELS_PATH, "utf8");
    const sandbox = { window: {}, module: { exports: null } };
    new Function("window", "module", src)(sandbox.window, sandbox.module);
    return sandbox.window.AI_MODELS?.models || sandbox.module.exports?.models || null;
  } catch {
    return null;
  }
}

module.exports = { runRefresh, lastRefresh: lastRefreshSummary, validateModels };
