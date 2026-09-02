/* ============================================================
   AI Price Chart — vanilla JS app
   Data: window.AI_MODELS (see data/models.js)
   ============================================================ */
"use strict";

const DATA = window.AI_MODELS;
const MODELS = DATA.models;
const MAJORS = ["OpenAI", "Anthropic", "Google", "xAI", "DeepSeek", "Meta", "Mistral",
  "Alibaba", "Moonshot AI", "Z.AI", "MiniMax", "Microsoft", "Amazon", "Cohere", "NVIDIA"];

const LS = {
  theme: "aipc.theme", calc: "aipc.calc", provs: "aipc.provs", priced: "aipc.priced", tier: "aipc.tier",
};

const state = {
  search: "",
  providers: new Set(),      // empty set = all providers
  type: "all",               // all | Proprietary | Open Weight
  pricedOnly: true,
  hideDeprecated: true,      // default: hide known-deprecated models
  sortKey: "blended",
  sortDir: 1,
  view: "table",
  calcIn: 8,                 // K input tokens / request
  calcOut: 2,                // K output tokens / request
  calcReqs: 1000,            // requests / month
  compare: new Set(),        // model ids (max 4)
  logScale: false,
  timeTier: "current",       // current | peak | off-peak
  user: null,                // {sub, name, email, picture} — set only after Google sign-in
  presets: [],               // saved views: [{id, name, view}]
};

/* ---------------- helpers ---------------- */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function blended(m) {
  const e = eff(m);
  if (e.input == null || e.output == null) return null;
  return (3 * e.input + e.output) / 4;
}
function monthlyCost(m) {
  const e = eff(m);
  if (e.input == null || e.output == null) return null;
  return (state.calcIn / 1000 * e.input + state.calcOut / 1000 * e.output) * state.calcReqs;
}
/* open weights with no first-party API rate: $0 in the source data, but not a real price */
const isSelfHost = (m) => m.input === 0 && m.output === 0 && !m.free;

/* ---- time-tiered pricing (e.g. DeepSeek peak/off-peak) ---- */

function isPeakNow(tt, now = new Date()) {
  const day = now.getUTCDay();               // 0 = Sunday … 6 = Saturday
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (Array.isArray(tt.peakDays) && !tt.peakDays.includes(day)) return false;
  return (tt.peakHours || []).some(([a, b]) => hour >= a && hour < b);
}

// effective price set for a model, honoring the global time-tier toggle
function tierEff(m) {
  if (!m.timeTiers || !m.timeTiers.offPeak) return null;
  const peak = state.timeTier === "current" ? isPeakNow(m.timeTiers) : state.timeTier === "peak";
  return peak
    ? { tier: "peak", input: m.input, cached: m.cached, output: m.output }
    : { tier: "off-peak", input: m.timeTiers.offPeak.input, cached: m.timeTiers.offPeak.cached, output: m.timeTiers.offPeak.output };
}
function eff(m) {
  const t = tierEff(m);
  return t || { tier: null, input: m.input, cached: m.cached, output: m.output };
}
function money(v) {
  if (v == null) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + parseFloat(v.toFixed(4));   // 0.0028 → $0.0028
  if (v < 1) return "$" + parseFloat(v.toFixed(3));      // 0.075 → $0.075, 0.44 → $0.44
  if (v < 1000) return "$" + v.toFixed(2);
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function monthly(money_) {
  if (money_ == null) return "—";
  if (money_ >= 1e9) return "$" + (money_ / 1e9).toFixed(2) + "B";
  if (money_ >= 1e6) return "$" + (money_ / 1e6).toFixed(2) + "M";
  if (money_ >= 1000) return "$" + (money_ / 1000).toFixed(1) + "K";
  return "$" + money_.toFixed(2);
}
const providerHue = (() => {
  const hues = {};
  let h = 15;
  for (const p of allProviders()) { hues[p] = h; h = (h + 47) % 360; }
  return (p) => hues[p] ?? 200;
})();

function allProviders() {
  return [...new Set(MODELS.map((m) => m.provider))].sort((a, b) => a.localeCompare(b));
}
function variantTag(v) {
  if (!v || v === "base") return null;
  return v.replace(/-/g, " ");
}
function badgeClass(v) {
  if (/reason|think/.test(v)) return "tag reasoning";
  if (/pro|flagship|luna|sol|terra/.test(v)) return "tag pro";
  return "tag";
}

/* ---------------- filtering / sorting ---------------- */

function filtered() {
  const q = state.search.trim().toLowerCase();
  let rows = MODELS.filter((m) => {
    if (q && !(m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))) return false;
    if (state.providers.size && !state.providers.has(m.provider)) return false;
    if (state.type !== "all") {
      const isOpen = m.type === "Open Weight";
      // API bucket = every hosted-API model, incl. non-standard statuses like "Pending"
      if (state.type === "Proprietary" && (isOpen || m.type === "Unknown")) return false;
      if (state.type === "Open Weight" && !isOpen) return false;
    }
    if (state.pricedOnly && (m.input == null || isSelfHost(m))) return false;
    if (state.hideDeprecated && m.deprecated) return false;
    return true;
  });

  const key = state.sortKey;
  const dir = state.sortDir;
  rows.sort((a, b) => {
    let va, vb;
    if (key === "blended") { va = blended(a); vb = blended(b); }
    else if (key === "monthly") { va = monthlyCost(a); vb = monthlyCost(b); }
    else { va = a[key]; vb = b[key]; }

    // $0 open-weight rows are "no first-party API price" — always sink to the
    // bottom of blended sorts so the top of the list shows real API prices.
    if (key === "blended") {
      const fa = !va, za = va === 0, fb = !vb, zb = vb === 0;
      if ((fa || za) && (fb || zb)) return a.name.localeCompare(b.name);
      if (fa || za) return 1;
      if (fb || zb) return -1;
    } else {
      if (va == null && vb == null) return a.name.localeCompare(b.name);
      if (va == null) return 1;
      if (vb == null) return -1;
    }
    if (typeof va === "string") return dir * va.localeCompare(vb) || a.name.localeCompare(b.name);
    return dir * (va - vb) || a.name.localeCompare(b.name);
  });
  return rows;
}

/* ---------------- stats ---------------- */

function renderStats(rows) {
  const priced = rows.filter((m) => !isSelfHost(m) && blended(m) != null && (blended(m) > 0 || m.free));
  const providers = new Set(rows.map((m) => m.provider)).size;
  const cheapest = priced.length ? priced.reduce((a, b) => (blended(a) <= blended(b) ? a : b)) : null;
  const dearest = priced.length ? priced.reduce((a, b) => (blended(a) >= blended(b) ? a : b)) : null;
  const withCost = rows.filter((m) => !isSelfHost(m) && monthlyCost(m) != null);
  const bestForWorkload = withCost.length
    ? withCost.reduce((a, b) => (monthlyCost(a) <= monthlyCost(b) ? a : b)) : null;

  const box = $("#stats");
  box.innerHTML = "";
  const add = (icon, k, v, s, cls) => {
    const d = el("div", "stat");
    d.append(el("div", "k", ""));
    d.firstChild.append(el("span", "ico", icon));
    d.firstChild.append(document.createTextNode(k));
    const val = el("div", "v" + (cls ? " " + cls : ""), v);
    d.append(val);
    if (s) d.append(el("div", "s", s));
    box.append(d);
  };
  add("📦", "Models shown", String(rows.length), `of ${MODELS.length} tracked · ${providers} providers`);
  add("🪶", "Cheapest", cheapest ? money(blended(cheapest)) : "—", cheapest ? `${cheapest.provider} · ${cheapest.name}` : "", "good");
  add("💸", "Priciest", dearest ? money(blended(dearest)) : "—", dearest ? `${dearest.provider} · ${dearest.name}` : "", "bad");
  add("🧮", "For your workload", bestForWorkload ? monthly(monthlyCost(bestForWorkload)) : "—",
    bestForWorkload
      ? `${bestForWorkload.name} · ${money(monthlyCost(bestForWorkload) / Math.max(state.calcReqs, 1))}/req`
      : `${state.calcReqs.toLocaleString()} req/mo · ${state.calcIn}K in / ${state.calcOut}K out`, "good");
}

/* ---------------- table ---------------- */

function maxVals(rows) {
  return {
    input: Math.max(...rows.map((m) => eff(m).input ?? 0), 1e-9),
    output: Math.max(...rows.map((m) => eff(m).output ?? 0), 1e-9),
    blended: Math.max(...rows.map((m) => blended(m) ?? 0), 1e-9),
  };
}
function priceCell(td, v, max, prefix = "") {
  td.textContent = prefix + (v == null ? "—" : money(v));
  if (v != null && max > 0) {
    const frac = state.logScale
      ? Math.log10(1 + v) / Math.log10(1 + max)
      : v / max;
    const bar = el("span", "pbar");
    bar.style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
    td.append(bar);
  }
}

function renderTable() {
  const rows = filtered();
  const max = maxVals(rows);
  const tb = $("#tbody");
  tb.innerHTML = "";

  const cheapestBlended = Math.min(...rows.map(blended).filter((v) => v != null && v > 0).concat(Infinity));

  for (const m of rows) {
    const tr = el("tr");
    tr.dataset.id = m.id;
    const e = eff(m);

    // compare checkbox
    const tdC = el("td", "cmp-col");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = state.compare.has(m.id);
    cb.title = "Add to comparison (max 4)";
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (state.compare.size >= 4) { cb.checked = false; flashTray("max 4 models"); return; }
        state.compare.add(m.id);
      } else state.compare.delete(m.id);
      renderTray();
    });
    tdC.append(cb);
    tr.append(tdC);

    // model name
    const tdN = el("td");
    const name = el("span", "m-name", m.name);
    name.tabIndex = 0;
    name.addEventListener("click", () => showDetail(m.id));
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") showDetail(m.id); });
    tdN.append(name);

    const sub = el("div", "m-sub");
    const vt = variantTag(m.variant);
    if (vt) sub.append(el("span", badgeClass(m.variant), vt));
    if (m.type === "Open Weight") sub.append(el("span", "tag open", "open"));
    if (m.type === "Pending") sub.append(el("span", "tag pro", "pending"));
    if (m.free) sub.append(el("span", "tag open", "free api"));
    if (m.timeTiers && e.tier) sub.append(el("span", e.tier === "peak" ? "tag peak" : "tag offpeak", e.tier === "peak" ? "peak now" : "off-peak −50%"));
    if (sub.childNodes.length) tdN.append(sub);
    tr.append(tdN);

    // provider column (dot + name; sorting key)
    const tdP = el("td");
    const pWrap = el("span", "m-sub");
    const dot = el("span", "pdot");
    dot.style.background = `hsl(${providerHue(m.provider)} 70% 60%)`;
    pWrap.append(dot);
    pWrap.append(el("span", "", m.provider));
    tdP.append(pWrap);
    tr.append(tdP);

    // context
    tr.append(el("td", "num ctx-cell", m.ctx ?? "—"));

    // prices (effective = honors time-tier toggle)
    const fill = (td, v, max) => {
      if (isSelfHost(m)) { td.textContent = "self-host"; td.classList.add("sh"); return; }
      priceCell(td, v, max);
    };
    const tdIn = el("td", "num price-cell"); fill(tdIn, e.input, max.input); tr.append(tdIn);
    const tdCa = el("td", "num price-cell col-cached");
    if (isSelfHost(m)) { tdCa.textContent = "—"; tdCa.classList.add("sh"); } else priceCell(tdCa, e.cached, max.input);
    tr.append(tdCa);
    const tdOut = el("td", "num price-cell"); fill(tdOut, e.output, max.output); tr.append(tdOut);

    const tdB = el("td", "num price-cell");
    const b = blended(m);
    const best = b != null && b > 0 && b === cheapestBlended;
    if (best) tdB.classList.add("best");
    if (isSelfHost(m)) { tdB.textContent = "self-host"; tdB.classList.add("sh"); }
    else priceCell(tdB, b, max.blended, best ? "★ " : "");
    tr.append(tdB);

    // score
    tr.append(el("td", "num score-cell col-score", m.score != null ? m.score.toFixed(1) : "—"));

    // your monthly cost
    const mc = isSelfHost(m) ? null : monthlyCost(m);
    tr.append(el("td", "num col-calc", mc == null ? "—" : (mc >= 1000 ? monthly(mc) : money(mc))));

    tb.append(tr);
  }

  $("#emptyMsg").hidden = rows.length > 0;
  document.querySelector("#priceTable thead").style.display = rows.length ? "" : "none";
  renderStats(rows);
}

/* ---------------- chart ---------------- */

function renderChart() {
  const wrap = $("#chart");
  wrap.innerHTML = "";
  let rows = filtered().filter((m) => !isSelfHost(m) && blended(m) != null && (blended(m) > 0 || m.free));
  rows.sort((a, b) => blended(a) - blended(b));

  const cap = Math.max(state.logScale ? 60 : 25, 0);
  rows = rows.slice(0, cap);
  if (!rows.length) { wrap.append(el("p", "empty", "No priced models match your filters.")); return; }

  const maxIn = Math.max(...rows.map((m) => eff(m).input ?? 0), 1e-9);
  const maxOut = Math.max(...rows.map((m) => eff(m).output ?? 0), 1e-9);
  // per-axis scale: input/output bars are scaled against their OWN axis max,
  // so a bar can never exceed 100% (scaling output by max blended was the overflow bug —
  // blended ≤ output under 3:1, so high-output models produced >100% bars → page stretched)
  const scaleFor = (axisMax) => (v) => state.logScale
    ? Math.log10(1 + v) / Math.log10(1 + axisMax)
    : v / axisMax;
  const scaleIn = scaleFor(maxIn), scaleOut = scaleFor(maxOut);
  const widthPct = (s) => Math.min(100, Math.max(0.4, s * 100));

  for (const m of rows) {
    const row = el("div", "chart-row");
    row.addEventListener("click", () => showDetail(m.id));

    const name = el("div", "chart-name");
    name.append(el("span", "", m.name));
    name.append(el("small", "", m.provider));
    row.append(name);

    const bars = el("div", "chart-bars");
    const mk = (v, cls) => {
      const holder = el("div", "bar-holder");
      holder.style.position = "relative";
      const b = el("div", "bar " + cls);
      b.style.width = widthPct(cls === "in" ? scaleIn(v) : scaleOut(v)) + "%";
      const lbl = el("span", "lbl", money(v));
      b.append(lbl);
      holder.append(b);
      return holder;
    };
    const e = eff(m);
    if (e.input != null && e.input > 0) bars.append(mk(e.input, "in"));
    if (e.output != null) bars.append(mk(e.output, "out"));
    row.append(bars);
    row.append(el("div", "chart-val", money(blended(m)) + " bl"));
    wrap.append(row);
  }

  const legend = el("div", "legend");
  const shown = filtered().filter((m) => !isSelfHost(m) && blended(m) != null && (blended(m) > 0 || m.free)).length;
  legend.innerHTML =
    `<span><span class="sw" style="background:linear-gradient(90deg,#6366f1,#818cf8)"></span>input $/M</span>` +
    `<span><span class="sw" style="background:linear-gradient(90deg,#0d9488,#5eead4)"></span>output $/M</span>` +
    `<span>showing ${rows.length} of ${shown} priced models</span>`;
  wrap.append(legend);
}

/* ---------------- detail modal ---------------- */

function showDetail(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) return;
  const b = blended(m), mc = monthlyCost(m);
  const e = eff(m);
  const body = $("#modalBody");
  body.innerHTML = "";

  body.append(el("h2", "", m.name));
  const prov = el("p", "sub");
  prov.append(el("span", "pdot", ""));
  prov.querySelector(".pdot").style.background = `hsl(${providerHue(m.provider)} 70% 60%)`;
  prov.append(` ${m.provider} · ${m.type}`);
  body.append(prov);

  const dl = el("dl", "kv");
  const addKV = (k, v) => { dl.append(el("dt", "", k)); const dd = el("dd"); dd.innerHTML = v; dl.append(dd); };
  const sh = isSelfHost(m);
  addKV("Input price", sh ? "self-host (open weights)" : e.input == null ? "—" : `${money(e.input)} <small>/ 1M tokens${e.tier ? " · " + e.tier : ""}</small>`);
  addKV("Cached input", sh ? "—" : e.cached == null ? "—" : `${money(e.cached)} <small>/ 1M tokens</small>`);
  addKV("Output price", sh ? "self-host (open weights)" : e.output == null ? "—" : `${money(e.output)} <small>/ 1M tokens${e.tier ? " · " + e.tier : ""}</small>`);
  addKV("Blended (3:1)", sh ? "—" : b == null ? "—" : `${money(b)} <small>/ 1M tokens</small>`);
  if (m.timeTiers) {
    const tt = m.timeTiers;
    const hours = (tt.peakHours || []).map(([a, b2]) => `${String(a).padStart(2, "0")}:00–${String(b2).padStart(2, "0")}:00`).join(" & ");
    const days = (tt.peakDays || []).length ? "Mon–Fri" : "daily";
    addKV("Peak rate", `${money(m.input)} in / ${money(m.output)} out <small>· ${days} ${hours} ${tt.tz || "UTC"}</small>`);
    addKV("Off-peak rate", `${money(tt.offPeak.input)} in / ${money(tt.offPeak.output)} out <small>· −50% all other hours</small>`);
    addKV("Effective now", tierEff(m)?.tier === "peak"
      ? "PEAK hours — full rate"
      : "off-peak — discounted rate");
  }
  addKV("Context window", m.ctx ?? "—");
  addKV("License / type", m.type);
  if (m.variant) addKV("Variant", m.variant);
  if (m.score != null) addKV("BenchLM score †", m.score.toFixed(1));
  if (m.note) addKV("Note", m.note);
  addKV("Dataset", `BenchLM ${DATA.period} snapshot`);
  body.append(dl);

  if (mc != null && mc > 0) {
    const cost = el("div", "big-cost");
    cost.innerHTML =
      `Your workload (${state.calcReqs.toLocaleString()} req/mo × ${state.calcIn}K in / ${state.calcOut}K out): ` +
      `<b>${monthly(mc)}</b> <span class="sub">per month ≈ ${money(mc / state.calcReqs)} per request</span>`;
    body.append(cost);
  }

  const links = el("p");
  const a = el("a", "", "View on BenchLM.ai ↗");
  a.href = m.url; a.target = "_blank"; a.rel = "noopener";
  links.append(a);
  body.append(links);

  openModal();
}

function compareModal() {
  const ids = [...state.compare];
  const ms = ids.map((id) => MODELS.find((x) => x.id === id)).filter(Boolean);
  if (!ms.length) return;

  const body = $("#modalBody");
  body.innerHTML = "";
  body.append(el("h2", "", "Side-by-side comparison"));

  const table = el("table", "cmp-table");
  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", "", ""));
  for (const m of ms) hr.append(el("th", "", `${m.name}`));
  thead.append(hr);
  table.append(thead);

  // [label, display fn, raw numeric fn, isLowerBetter]
  const price = (v) => v == null ? "—" : money(v);
  const rowDefs = [
    ["Provider", (m) => m.provider, () => null],
    ["Input $/M", (m) => isSelfHost(m) ? "self-host" : price(eff(m).input), (m) => isSelfHost(m) ? null : eff(m).input, true],
    ["Cached input $/M", (m) => price(eff(m).cached), (m) => isSelfHost(m) ? null : eff(m).cached, true],
    ["Output $/M", (m) => isSelfHost(m) ? "self-host" : price(eff(m).output), (m) => isSelfHost(m) ? null : eff(m).output, true],
    ["Blended $/M (3:1)", (m) => isSelfHost(m) ? "self-host" : price(blended(m)), (m) => isSelfHost(m) ? null : blended(m), true],
    ["Context", (m) => m.ctx ?? "—", (m) => m.ctxTok, false],
    ["Type", (m) => m.type, () => null],
    ["BenchLM score †", (m) => m.score == null ? "—" : m.score.toFixed(1), (m) => m.score, false],
    ["You / mo", (m) => { if (isSelfHost(m)) return "self-host"; const c = monthlyCost(m); return c == null ? "—" : monthly(c); },
      (m) => isSelfHost(m) ? null : monthlyCost(m), true],
    ["Link", (m) => `<a href="${m.url}" target="_blank" rel="noopener">BenchLM ↗</a>`, () => null],
  ];

  const tbody = el("tbody");
  for (const [label, fmt, raw, lowerBetter] of rowDefs) {
    const raws = ms.map(raw).filter((v) => v != null);
    const best = raws.length
      ? (lowerBetter ? Math.min(...raws) : Math.max(...raws))
      : null;
    const tr = el("tr");
    tr.append(el("td", "", label));
    for (const m of ms) {
      const td = el("td");
      const display = fmt(m);
      if (typeof display === "string" && display.startsWith("<a")) td.innerHTML = display;
      else td.textContent = display;
      const rv = raw(m);
      if (best != null && rv != null && Math.abs(rv - best) < 1e-9 && ms.length > 1) td.classList.add("winner");
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);

  const hint = el("p", "sub", "Green = best value in this selection (cheapest price / cost, highest score).");
  hint.style.marginTop = "12px";
  body.append(hint);
  openModal();
}

function openModal() { $("#modal").hidden = false; document.body.style.overflow = "hidden"; }
function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }

/* ---------------- tray ---------------- */

function renderTray() {
  const tray = $("#tray");
  if (!state.compare.size) { tray.hidden = true; return; }
  tray.hidden = false;
  $("#trayLabel").textContent = `${state.compare.size} selected for comparison`;
}
function flashTray(msg) {
  const l = $("#trayLabel");
  const old = l.textContent;
  l.textContent = msg;
  setTimeout(() => { l.textContent = old; renderTray(); }, 1200);
}

/* ---------------- CSV export ---------------- */

function exportCSV() {
  const rows = filtered();
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["id", "provider", "model", "variant", "type", "context_tokens", "pricing_tier",
    "input_usd_per_m", "cached_usd_per_m", "output_usd_per_m", "blended_usd_per_m",
    "benchlm_score", "your_cost_usd_per_month"];
  const lines = [head.join(",")];
  for (const m of rows) {
    const e = eff(m);
    lines.push([
      m.id, m.provider, m.name, m.variant ?? "", m.type, m.ctxTok ?? "", e.tier ?? "",
      e.input ?? "", e.cached ?? "", e.output ?? "", blended(m) != null ? blended(m).toFixed(6) : "",
      m.score ?? "", monthlyCost(m) != null ? monthlyCost(m).toFixed(4) : "",
    ].map(esc).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ai-prices-${DATA.asOf}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- provider picker ---------------- */

function renderProvList() {
  const list = $("#provList");
  list.innerHTML = "";
  const q = ($("#provSearch").value || "").trim().toLowerCase();
  const counts = {};
  for (const m of MODELS) counts[m.provider] = (counts[m.provider] || 0) + 1;
  for (const p of allProviders()) {
    if (q && !p.toLowerCase().includes(q)) continue;
    const label = el("label", "prov-item");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = state.providers.has(p);
    cb.addEventListener("change", () => {
      if (cb.checked) state.providers.add(p); else state.providers.delete(p);
      saveProvs(); updateProvCount(); renderCurrent();
    });
    label.append(cb);
    const dot = el("span", "pdot");
    dot.style.background = `hsl(${providerHue(p)} 70% 60%)`;
    label.append(dot);
    label.append(el("span", "n", p));
    label.append(el("span", "c", String(counts[p])));
    list.append(label);
  }
}
function updateProvCount() {
  $("#provCount").textContent = state.providers.size ? `(${state.providers.size})` : "";
}
function saveProvs() {
  localStorage.setItem(LS.provs, JSON.stringify([...state.providers]));
}

/* ---------------- theme ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "light" ? "☀️" : "🌙";
  localStorage.setItem(LS.theme, t);
}

/* ---------------- render dispatcher ---------------- */

function renderCurrent() {
  const isChart = state.view === "chart";
  $("#tableView").hidden = isChart;
  $("#chartView").hidden = !isChart;
  $("#logWrap").hidden = !isChart;
  if (isChart) renderChart(); else renderTable();
  scheduleUrlSync();
}

/* ---------------- shareable URLs ----------------
   A view is just a URL: ?q=sonnet&provs=Anthropic,OpenAI&in=8&out=2&reqs=1000&cmp=a,b,c&tier=off-peak
   Nothing here needs an account — sharing a comparison is a link, not a preset. */

const URL_KEYS = ["q", "provs", "type", "priced", "dep", "sort", "dir", "tier", "in", "out", "reqs", "cmp", "view"];
let _urlTimer = null;

function syncUrl() {
  clearTimeout(_urlTimer);
  _urlTimer = setTimeout(() => {
    const p = new URLSearchParams();
    const q = state.search.trim();
    if (q) p.set("q", q);
    if (state.providers.size) p.set("provs", [...state.providers].join(","));
    if (state.type !== "all") p.set("type", state.type);
    if (!state.pricedOnly) p.set("priced", "0");
    if (!state.hideDeprecated) p.set("dep", "0");
    if (state.sortKey !== "blended") p.set("sort", state.sortKey);
    if (state.sortDir === -1) p.set("dir", "desc");
    if (state.timeTier !== "current") p.set("tier", state.timeTier);
    if (state.calcIn !== 8) p.set("in", state.calcIn);
    if (state.calcOut !== 2) p.set("out", state.calcOut);
    if (state.calcReqs !== 1000) p.set("reqs", state.calcReqs);
    if (state.compare.size) p.set("cmp", [...state.compare].join(","));
    if (state.view !== "table") p.set("view", state.view);
    const qs = p.toString();
    const url = qs ? "?" + qs : location.pathname;
    try { history.replaceState(null, "", url); } catch { /* sandboxed */ }
  }, 250);
}
function scheduleUrlSync() { if (!_urlLock) syncUrl(); }
let _urlLock = false; // set while applying a shared URL so we don't echo it back

function urlToState() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.has("q")) state.search = p.get("q");
    if (p.has("provs")) {
      const known = allProviders();
      state.providers = new Set(p.get("provs").split(",").map((s) => s.trim()).filter((x) => known.includes(x)));
    }
    if (p.has("type") && ["all", "Proprietary", "Open Weight"].includes(p.get("type"))) state.type = p.get("type");
    if (p.has("priced")) state.pricedOnly = p.get("priced") !== "0";
    if (p.has("dep")) state.hideDeprecated = p.get("dep") !== "0";
    if (p.has("sort") && ["blended", "input", "output", "ctx", "score", "monthly"].includes(p.get("sort"))) state.sortKey = p.get("sort");
    if (p.get("dir") === "desc") state.sortDir = -1;
    if (p.has("tier") && ["current", "peak", "off-peak"].includes(p.get("tier"))) state.timeTier = p.get("tier");
    if (p.has("in")) state.calcIn = Math.max(0, parseFloat(p.get("in")) || state.calcIn);
    if (p.has("out")) state.calcOut = Math.max(0, parseFloat(p.get("out")) || state.calcOut);
    if (p.has("reqs")) state.calcReqs = Math.max(0, parseFloat(p.get("reqs")) || state.calcReqs);
    if (p.has("cmp")) {
      const ids = new Set(MODELS.map((m) => m.id));
      state.compare = new Set(p.get("cmp").split(",").filter((id) => ids.has(id)).slice(0, 4));
    }
    if (p.has("view") && ["table", "chart"].includes(p.get("view"))) state.view = p.get("view");
    return p.toString().length > 0;
  } catch { return false; }
}

/* ---------------- init ---------------- */

/* ================= Presets + Google sign-in =================
   Browsing/searching is anonymous and always available.
   Google sign-in only unlocks SAVING presets (cross-device sync).
   Presets store the whole view: search, filters, sort, tier mode,
   workload numbers and the current 4-way comparison set. */

function captureView() {
  return {
    q: $("#search").value,
    provs: [...state.providers],
    type: state.type,
    priced: $("#pricedOnly").checked,
    hideDep: $("#hideDeprecated")?.checked ?? false,
    sort: state.sortKey, dir: state.sortDir === 1 ? "asc" : "desc",
    tier: state.timeTier,
    calcIn: state.calcIn, calcOut: state.calcOut, calcReqs: state.calcReqs,
    cmp: [...state.compare],
  };
}

function applyView(v) {
  if (!v || typeof v !== "object") return;
  $("#search").value = v.q || "";
  $("#search").dispatchEvent(new Event("input", { bubbles: true }));
  const known = allProviders();
  state.providers = new Set(Array.isArray(v.provs) ? v.provs.filter((p) => known.includes(p)) : []);
  state.type = ["all", "Proprietary", "Open Weight"].includes(v.type) ? v.type : "all";
  document.querySelectorAll("#typeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
  $("#pricedOnly").checked = v.priced !== false;
  if ($("#hideDeprecated")) $("#hideDeprecated").checked = v.hideDep !== false;
  if (["blended", "input", "output", "ctx", "score"].includes(v.sort)) state.sortKey = v.sort;
  state.sortDir = v.dir === "desc" ? -1 : 1;
  if (["current", "peak", "off-peak"].includes(v.tier)) {
    state.timeTier = v.tier;
    document.querySelectorAll("#tierSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tier === v.tier));
  }
  ["calcIn", "calcOut", "calcReqs"].forEach((k, i) => {
    const ids = ["calcIn", "calcOut", "calcReqs"];
    if (v[k] != null && v[k] > 0) { state[k] = v[k]; $("#" + ids[i]).value = v[k]; }
  });
  const ids = new Set(MODELS.map((m) => m.id));
  state.compare = new Set((v.cmp || []).filter((id) => ids.has(id)).slice(0, 4));
  renderTray(); renderCurrent();
  if (state.compare.size >= 2) compareModal();
}

function toast(msg, ms = 3200) {
  let t = document.getElementById("toast");
  if (!t) { t = el("div", "toast"); t.id = "toast"; document.body.append(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

function renderAuthUI() {
  const wrap = $("#gBtnWrap"), chip = $("#userChip"), fallback = $("#signInFallback");
  if (state.user) {
    wrap.hidden = true; fallback.hidden = true;
    chip.hidden = false;
    $("#userPic").src = state.user.picture || "";
    $("#userName").textContent = (state.user.name || "").split(" ")[0] || "you";
    return;
  }
  chip.hidden = true;
  // the real Google button exists only after the GIS script renders its iframe
  const realButtonReady = !!wrap.querySelector("iframe");
  wrap.hidden = !realButtonReady;
  fallback.hidden = realButtonReady;
}

function jwtPayload(token) {
  try {
    const p = token.split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

function onGoogleCredential(resp) {
  const claims = jwtPayload(resp.credential);
  if (!claims || !claims.sub) return toast("Google sign-in failed");
  state.user = { sub: claims.sub, name: claims.name || "", email: claims.email || "", picture: claims.picture || "" };
  sessionStorage.setItem("aipc.token", resp.credential);
  localStorage.setItem("aipc.user", JSON.stringify(state.user));
  renderAuthUI();
  toast(`Signed in as ${state.user.name || state.user.email} — presets will sync`);
  loadPresets();
}

function initAuth() {
  $("#signOutBtn").addEventListener("click", () => {
    try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* not loaded */ }
    state.user = null; state.presets = [];
    sessionStorage.removeItem("aipc.token");
    localStorage.removeItem("aipc.user");
    localStorage.removeItem("aipc.presetsCache");
    renderAuthUI(); renderPresetChips();
    toast("Signed out — browsing stays fully available");
  });
  $("#signInFallback").addEventListener("click", () => {
    if (window.google?.accounts?.id) {
      try { return window.google.accounts.id.prompt(); } catch { /* fall through */ }
    }
    if (!window.GOOGLE_CLIENT_ID) {
      toast("Google sign-in needs a one-time setup: create an OAuth Client ID and put it in client-id.js — see README “Google login & saved presets”", 6000);
    } else {
      toast("Google script hasn't loaded — check your network / ad blocker and retry", 5000);
    }
  });

  // restore profile from a previous visit on this device
  const cached = localStorage.getItem("aipc.user");
  if (cached) { try { state.user = JSON.parse(cached); } catch { /* ignore */ } }
  const cachedPresets = localStorage.getItem("aipc.presetsCache");
  if (cachedPresets) { try { state.presets = JSON.parse(cachedPresets); } catch { /* ignore */ } }
  renderAuthUI(); renderPresetChips();

  if (!window.GOOGLE_CLIENT_ID) return; // anonymous-only deployment
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true; s.defer = true;
  s.onload = () => {
    try {
      window.google.accounts.id.initialize({
        client_id: window.GOOGLE_CLIENT_ID,
        callback: onGoogleCredential,
        auto_select: false,
      });
      // THE actual button — without this the container stays an empty div
      window.google.accounts.id.renderButton($("#gBtnWrap"), {
        theme: "outline", size: "medium", text: "signin_with",
        shape: "pill", width: 128, logo_alignment: "left",
      });
    } catch (e) {
      console.error("GIS init failed:", e);
    }
    renderAuthUI();
  };
  s.onerror = () => { renderAuthUI(); toast("Google sign-in script blocked (ad blocker / network) — presets still work on this device", 5000); };
  document.head.append(s);
}

async function apiPresets(method, body) {
  const token = sessionStorage.getItem("aipc.token");
  if (!token) throw new Error("not signed in");
  const res = await fetch("/api/presets", {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { // token expired (1h) — force re-auth
    signOutQuiet();
    throw new Error("session expired — please sign in again");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `API ${res.status}`);
  return j;
}

function signOutQuiet() {
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* not loaded */ }
  state.user = null;
  sessionStorage.removeItem("aipc.token");
  localStorage.removeItem("aipc.user");
  renderAuthUI();
}

function cachePresets() {
  localStorage.setItem("aipc.presetsCache", JSON.stringify(state.presets));
}

async function loadPresets() {
  try {
    const j = await apiPresets("GET");
    state.presets = Array.isArray(j.presets) ? j.presets : [];
    cachePresets(); renderPresetChips();
  } catch (e) {
    renderPresetChips(); // fall back to cached/local presets
    if (!/not signed in/.test(e.message)) toast(`Preset sync unavailable: ${e.message}`);
  }
}

function localPresetsSave() {
  cachePresets();
  renderPresetChips();
  toast("Saved on this device (cloud sync unavailable here)");
}

async function savePreset() {
  const existing = state.presets.map((p) => p.name);
  const def = `My compare ${state.presets.length + 1}`;
  const name = prompt("Preset name (saves search, filters, sort, calculator and comparison):", existing[existing.length - 1] || def);
  if (name == null || !name.trim()) return;
  const preset = { id: "p_" + Date.now().toString(36), name: name.trim().slice(0, 60), view: captureView() };
  const prev = state.presets;
  state.presets = [...state.presets.filter((p) => p.name !== preset.name), preset].slice(0, 50);
  renderPresetChips();
  cachePresets(); // always saved locally first — Google is just the sync layer
  if (!state.user) {
    toast(`Preset "${preset.name}" saved on this device — sign in to sync it across devices`);
    return;
  }
  try {
    await apiPresets("PUT", { presets: state.presets });
    toast(`Preset "${preset.name}" saved & synced — click its chip to restore`);
  } catch (e) {
    state.presets = prev; renderPresetChips(); cachePresets();
    toast(`Cloud sync failed (${e.message}) — kept locally`);
  }
}

function renderPresetChips() {
  const bar = $("#presetsBar"), chips = $("#presetChips");
  const show = state.user || state.presets.length > 0;
  bar.hidden = !show;
  chips.innerHTML = "";
  for (const p of state.presets) {
    const chip = el("button", "chip preset-chip", "");
    chip.title = "Apply this saved view";
    chip.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="chip-x" title="Delete preset">✕</span>`;
    chip.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("chip-x")) {
        state.presets = state.presets.filter((x) => x.id !== p.id);
        if (state.user) apiPresets("PUT", { presets: state.presets }).then(cachePresets).catch(() => localPresetsSave());
        else cachePresets();
        renderPresetChips();
        toast(`Deleted "${p.name}"`);
      } else {
        applyView(p.view);
        toast(`Applied "${p.name}"`);
      }
    });
    chips.append(chip);
  }
  if (!state.presets.length && state.user) {
    chips.append(el("span", "sub", "No presets yet — set up a view and click 💾 Save view"));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function init() {
  // auth + presets UI
  $("#savePresetBtn").addEventListener("click", savePreset);
  initAuth();

  // theme
  applyTheme(localStorage.getItem(LS.theme) || "dark");

  // dataset meta — single freshness source (badge, footer, meta all from DATA.asOf)
  $("#asOfBadge").textContent = `data: ${DATA.asOf}`;
  const fd = document.getElementById("footerDate");
  if (fd) fd.textContent = `data snapshot ${DATA.asOf} · refreshed ${DATA.period ? "from " + DATA.period : ""}· prices change often`;
  const md = document.querySelector('meta[name="description"]');
  if (md) md.content = `Compare current AI/LLM API prices — input, output, cached and blended per 1M tokens across 60+ providers. ${DATA.models.length} models tracked, snapshot ${DATA.asOf}.`;

  // sources
  const src = $("#sources");
  for (const s of DATA.sources) {
    const a = el("a", "", s.name);
    a.href = s.url; a.target = "_blank"; a.rel = "noopener";
    src.append(a);
  }

  // restore calc + priced pref + providers (URL params below override these)
  try {
    const c = JSON.parse(localStorage.getItem(LS.calc) || "null");
    if (c) { state.calcIn = c.in; state.calcOut = c.out; state.calcReqs = c.reqs; }
    state.pricedOnly = localStorage.getItem(LS.priced) !== "0";
    const ps = JSON.parse(localStorage.getItem(LS.provs) || "[]");
    state.providers = new Set(ps.filter((p) => MODELS.some((m) => m.provider === p)));
  } catch { /* first run */ }
  const hasUrl = urlToState(); // shared link wins over saved prefs
  $("#calcIn").value = state.calcIn;
  $("#calcOut").value = state.calcOut;
  $("#calcReqs").value = state.calcReqs;
  $("#pricedOnly").checked = state.pricedOnly;
  if ($("#hideDeprecated")) $("#hideDeprecated").checked = state.hideDeprecated;
  updateProvCount();

  // search
  $("#search").addEventListener("input", (e) => { state.search = e.target.value; renderCurrent(); });
  if (state.search) $("#search").value = state.search; // from shared URL

  // hide-deprecated
  if ($("#hideDeprecated")) {
    $("#hideDeprecated").addEventListener("change", (e) => {
      state.hideDeprecated = e.target.checked;
      renderCurrent();
    });
  }

  // provider picker
  $("#provSearch").addEventListener("input", renderProvList);
  $("#provAll").addEventListener("click", () => { state.providers.clear(); saveProvs(); updateProvCount(); renderProvList(); renderCurrent(); });
  $("#provNone").addEventListener("click", () => {
    // "Check all" — tick every provider explicitly (still shows everything)
    state.providers = new Set(allProviders());
    saveProvs(); updateProvCount(); renderProvList(); renderCurrent();
  });
  $("#provTop").addEventListener("click", () => {
    state.providers = new Set(MAJORS);
    saveProvs(); updateProvCount(); renderProvList(); renderCurrent();
  });
  renderProvList();

  // type segment (scoped to #typeSeg — tier buttons below share the .seg-btn class)
  document.querySelectorAll("#typeSeg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#typeSeg .seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.type = b.dataset.type;
      renderCurrent();
    });
  });

  // priced-only
  $("#pricedOnly").addEventListener("change", (e) => {
    state.pricedOnly = e.target.checked;
    localStorage.setItem(LS.priced, state.pricedOnly ? "1" : "0");
    renderCurrent();
  });

  // calculator
  const calcChanged = () => {
    state.calcIn = Math.max(0, parseFloat($("#calcIn").value) || 0);
    state.calcOut = Math.max(0, parseFloat($("#calcOut").value) || 0);
    state.calcReqs = Math.max(0, parseFloat($("#calcReqs").value) || 0);
    localStorage.setItem(LS.calc, JSON.stringify({ in: state.calcIn, out: state.calcOut, reqs: state.calcReqs }));
    renderCurrent();
  };
  ["calcIn", "calcOut", "calcReqs"].forEach((id) => $("#" + id).addEventListener("input", calcChanged));

  // tabs
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
      t.classList.add("active"); t.setAttribute("aria-selected", "true");
      state.view = t.dataset.view;
      renderCurrent();
    });
  });

  // log scale
  $("#logScale").addEventListener("change", (e) => { state.logScale = e.target.checked; renderCurrent(); });

  // time-tier toggle (peak / off-peak models like DeepSeek)
  document.querySelectorAll("#tierSeg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#tierSeg .seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.timeTier = b.dataset.tier;
      localStorage.setItem(LS.tier, state.timeTier);
      renderCurrent();
    });
  });
  {
    const savedTier = localStorage.getItem(LS.tier);
    if (["current", "peak", "off-peak"].includes(savedTier)) {
      state.timeTier = savedTier;
      document.querySelectorAll("#tierSeg .seg-btn").forEach((x) =>
        x.classList.toggle("active", x.dataset.tier === savedTier));
    }
  }
  // re-render every minute so "Now" pricing stays accurate while the page is open
  setInterval(() => { if (state.timeTier === "current") renderCurrent(); }, 60000);

  // sorting
  document.querySelectorAll("#priceTable th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      document.querySelectorAll("#priceTable th.sortable").forEach((x) => {
        const a = x.querySelector(".arr"); if (a) a.remove();
      });
      const arr = el("span", "arr", state.sortDir === 1 ? "▲" : "▼");
      th.append(arr);
      th.setAttribute("aria-sort", state.sortDir === 1 ? "ascending" : "descending");
      renderTable();
    });
  });
  // default sort arrow (respects URL/preset-driven direction)
  const defaultTh = document.querySelector(`#priceTable th[data-key="${state.sortKey}"]`);
  if (defaultTh) {
    defaultTh.append(el("span", "arr", state.sortDir === 1 ? "▲" : "▼"));
    defaultTh.setAttribute("aria-sort", state.sortDir === 1 ? "ascending" : "descending");
  }

  // tray + modal
  $("#compareBtn").addEventListener("click", compareModal);
  $("#clearCmp").addEventListener("click", () => { state.compare.clear(); renderTray(); renderTable(); });
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // csv + theme
  $("#csvBtn").addEventListener("click", () => { exportCSV(); toast("CSV downloaded ✓"); });
  $("#themeBtn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });

  // reflect URL-driven state in the UI (segments/tabs) before first paint
  document.querySelectorAll("#typeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
  document.querySelectorAll("#tierSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tier === state.timeTier));
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === state.view;
    t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on));
  });
  if (state.compare.size) renderTray();

  _urlLock = false;
  renderCurrent();
}

document.addEventListener("DOMContentLoaded", init);
