# 💸 AI Price Chart

A static, dependency-free web app that compares the **current prices of AI / LLM models**
across every major provider — OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Meta,
Alibaba (Qwen), Moonshot (Kimi), Z.AI (GLM), MiniMax, Cohere, NVIDIA, IBM, and ~50 more.

**Data snapshot: 2026-08-30 · 291 models · 66 providers · prices in USD per 1M tokens.**

## Run it

```bash
npm start          # → http://localhost:4173
```

(or any static server, e.g. `python3 -m http.server` — there is no build step)

## Refresh API (for scheduled updates)

| Endpoint | Access | What it does |
|---|---|---|
| `GET /api/refresh` | 🔒 token + loopback only | Re-scrapes BenchLM + official provider pricing docs (Z.AI, DeepSeek), applies overrides, **regenerates `data/models.js`**, returns a JSON change summary |
| `POST /api/refresh` | 🔒 token + loopback only | Same — for cron jobs |
| `GET /api/health` | open | Dataset date, model count, last-refresh summary (no secrets) |
| `GET /api/models` | open | Current dataset as plain JSON |

**Security** — only you can refresh:

- On first start the server generates a 192-bit secret token and stores it in
  `.refresh-token` (file mode `0600`, gitignored).
- `/api/refresh` accepts it via `Authorization: Bearer …` (recommended) or `?token=…`,
  compared in constant time (`crypto.timingSafeEqual`).
- Refresh is **restricted to loopback connections** — even with a leaked token, other
  machines on your network cannot call it. Run with `ALLOW_REMOTE_REFRESH=1` to lift
  this (token still required).
- `REFRESH_TOKEN=<secret> npm start` overrides the file — useful for containers.

```bash
npm run token             # print your token
npm run token -- rotate   # invalidate the old one (update your crontab!)

curl -X POST http://localhost:4173/api/refresh \
     -H "Authorization: Bearer $(cat .refresh-token)"
```

**Cron example** (daily at 06:00 — use the header form, not `?token=`, to keep it out of logs):

```
0 6 * * * curl -s -X POST http://localhost:4173/api/refresh -H "Authorization: Bearer $(cat /path/to/aiPriceChart/.refresh-token)" >> /var/log/aiprice-refresh.log 2>&1
```

### How refresh works

1. **BenchLM.ai** pricing table (`__NEXT_DATA__`) → base dataset (~290 models)
2. **Official provider docs** (live parsers, failures tolerated):
   - Z.AI `docs.z.ai/.../pricing.md` — parses the markdown tables, handles promo strikethroughs (`~~$0.15~~ $0.075`) and Free rows
   - DeepSeek `api-docs.deepseek.com` — extracts peak input/output/cache rates (off-peak is half)
3. **`data/overrides.json`** — verified manual corrections; applied under the live parsers (which win per-model). `nullPrices` marks deprecated models (e.g. DeepSeek V3.1) as unpriced.
4. Diff vs previous dataset → atomic rewrite of `data/models.js` + backup in `data/backups/` + summary in `data/last-refresh.json`.

Refresh response example:

```json
{ "ok": true, "models": 291, "priced": 243, "overridesApplied": 15,
  "changes": [ { "id": "glm-5-3", "field": "input", "from": 0, "to": 1.4 }, … ] }
```

## Price semantics

- **Priced** — first-party API rate (input / cached / output, USD per 1M tokens)
- **`free api`** — genuinely $0 on the provider's own API (e.g. GLM-4.7-Flash); wins "cheapest" honestly
- **`self-host`** — open weights, no first-party API rate in the dataset; shown as italic "self-host", excluded from cheapest/cost stats and the chart
- **`—`** — unpriced/deprecated in the dataset

The ★ marks the cheapest priced model in the current view. **Blended** = (3 × input + 1 × output) ÷ 4.

## Features

| | |
|---|---|
| 🔎 **Search & filter** | by model/provider name, provider multi-select (with "Majors only" shortcut), API vs open-weights, hide unpriced |
| 🧮 **Workload calculator** | enter your avg input/output tokens and requests/month → live "You / mo" cost column for every model |
| 📊 **Table & chart views** | sortable price table with inline magnitude bars; log/linear bar chart of input vs output prices |
| ⚖️ **Side-by-side compare** | pick up to 4 models, best value per row highlighted |
| ⬇ **CSV export** | export the current filtered view |
| 🌙 **Dark / light theme** | preferences persisted in localStorage |

**Blended price** = (3 × input + 1 × output) ÷ 4 — the common 3:1 workload approximation used
for cheap cross-model comparison. The ★ marks the cheapest priced model in the current view.

## Files

```
index.html          app shell
styles.css          theme (dark default) + responsive layout
app.js              filtering, sorting, calculator, chart, compare, CSV
server.js           tiny static file server (no dependencies)
data/models.js      the pricing dataset (plain JS, easy to edit)
```

## Data sources & freshness

Aggregated from [BenchLM.ai's LLM pricing table](https://benchlm.ai/llm-pricing)
(August 2026 snapshot, `lastUpdated 2026-08-30`) and spot-checked against
[FutureAGI cost calculators](https://futureagi.com/llm-cost-calculator) for flagship models
(GPT-5.2 $1.75/$14, Claude Opus 4.6 $5/$25, Gemini 3.1 Pro $2/$12 — all confirmed).

> ⚠️ AI prices change weekly. Every model row links to its BenchLM page, and the footer links
> all sources — **always confirm on the provider's official pricing page before purchasing.**

### Refreshing the data

`data/models.js` is generated from BenchLM's embedded page data. To refresh:

1. `curl -sL https://benchlm.ai/llm-pricing -o /tmp/benchlm.html`
2. Extract the `<script id="__NEXT_DATA__" type="application/json">` block
3. Map `props.pageProps.pricingPageData.models[]` fields:
   `model→name, creator→provider, variantType→variant, inputPrice→input,
   cachedInputPrice→cached, outputPrice→output, contextSize→ctxTok, sourceType→type,
   overallScore→score, slug→id`
4. Rebuild `data/models.js` with the same record shape (see the header comment in that file).

Models without a first-party API rate (open weights) have `input: null` or `0` —
the app shows them with an `open` badge and excludes them from "cheapest" highlights.
