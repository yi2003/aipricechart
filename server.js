/* Static file server + refresh API for AI Price Chart — no dependencies.
   Endpoints:
     GET  /api/health   → dataset status + last refresh summary
     GET  /api/models   → current dataset as JSON
     GET  /api/refresh  → re-scrape sources, regenerate data/models.js (POST also accepted)
                          RESTRICTED: loopback-only + bearer token (see token.js).
                          Env: REFRESH_TOKEN overrides the generated token file;
                          ALLOW_REMOTE_REFRESH=1 lifts the loopback restriction.
     View the token:    npm run token      Rotate it:  npm run token -- rotate
*/
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { runRefresh, lastRefresh } = require("./refresh");
const { loadOrCreate, safeEqual, TOKEN_PATH } = require("./token");

const ROOT = __dirname;
const PORT = process.env.PORT || 4173;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || loadOrCreate();
const LOOPBACK_ONLY = process.env.ALLOW_REMOTE_REFRESH !== "1";
const DATA_PATH = path.join(ROOT, "data", "models.js");

const LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj, null, 2));
}

function currentDataset() {
  try {
    const sandbox = { window: {}, module: { exports: null } };
    new Function("window", "module", fs.readFileSync(DATA_PATH, "utf8"))(sandbox.window, sandbox.module);
    return sandbox.window.AI_MODELS || sandbox.module.exports || null;
  } catch {
    return null;
  }
}

function authorized(req, url) {
  // 1) loopback-only by default — even a leaked token is useless from other machines
  if (LOOPBACK_ONLY && !LOOPBACKS.has(req.socket.remoteAddress || "")) return false;
  // 2) token check — ?token=… or Authorization: Bearer …, compared in constant time
  const supplied = url.searchParams.get("token") ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!supplied) return false;
  return safeEqual(supplied, REFRESH_TOKEN);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const p = url.pathname;

  /* ---------- API ---------- */
  if (p === "/api/health") {
    const d = currentDataset();
    return sendJSON(res, 200, {
      ok: true,
      asOf: d?.asOf ?? null,
      models: d?.models?.length ?? 0,
      benchlmLastUpdated: d?.benchlmLastUpdated ?? null,
      lastRefresh: lastRefresh(),
    });
  }

  if (p === "/api/models") {
    const d = currentDataset();
    if (!d) return sendJSON(res, 500, { ok: false, error: "dataset unavailable" });
    return sendJSON(res, 200, d);
  }

  if (p === "/api/refresh") {
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405).end("Method not allowed");
      return;
    }
    if (!authorized(req, url)) {
      const remote = req.socket.remoteAddress;
      const loopback = LOOPBACKS.has(remote || "");
      return sendJSON(res, loopback ? 401 : 403, {
        ok: false,
        error: loopback
          ? "missing or invalid refresh token (npm run token)"
          : `refresh is restricted to localhost${LOOPBACK_ONLY ? "" : " (token still required)"}`,
      });
    }
    try {
      const dryRun = url.searchParams.get("dryRun") === "1";
      const summary = await runRefresh(
        req.method === "POST" ? "scheduled" : "scheduled-get",
        { dryRun }
      );
      return sendJSON(res, 200, summary);
    } catch (e) {
      if (e.code === "ALREADY_RUNNING") return sendJSON(res, 409, { ok: false, error: e.message });
      console.error("[refresh] failed:", e);
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (p.startsWith("/api/")) return sendJSON(res, 404, { ok: false, error: "unknown endpoint" });

  /* ---------- static ---------- */
  let urlPath = decodeURIComponent(p);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 — not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  const readyToPaste = `curl -X POST http://localhost:${PORT}/api/refresh -H "Authorization: Bearer $(cat ${TOKEN_PATH})"`;
  console.log(`\n  💸 AI Price Chart running at:\n\n     http://localhost:${PORT}\n\n  API: /api/health · /api/models · /api/refresh
  Security: refresh requires your secret token${LOOPBACK_ONLY ? " + loopback connection" : ""}
            token file : ${TOKEN_PATH} (0600)
            show token : npm run token
            rotate     : npm run token -- rotate
            ready curl : ${readyToPaste}\n`);
});
