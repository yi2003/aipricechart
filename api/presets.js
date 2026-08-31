// Vercel serverless function: per-user preset storage for signed-in users.
//   GET  /api/presets           → { presets: [...] }
//   PUT  /api/presets           → replace full preset list (body: { presets: [...] })
// Auth: Google ID token (Authorization: Bearer <jwt>), signature-verified against
// Google's public JWKS. Storage: Vercel KV (Upstash) REST — one JSON blob per user.
import crypto from "node:crypto";

const MAX_PRESETS = 50;
const MAX_VIEW_BYTES = 20 * 1024;
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

let jwksCache = { keys: null, fetchedAt: 0 };

async function jwks() {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < 3600_000) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const j = await res.json();
  jwksCache = { keys: j.keys, fetchedAt: Date.now() };
  return j.keys;
}

const b64urlJson = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"));

// returns payload claims or throws with a human-readable reason
async function verifyGoogleIdToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256") throw new Error("unsupported alg");

  const keys = await jwks();
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error("unknown key id");

  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(`${parts[0]}.${parts[1]}`)
    .verify({ key: jwkToPem(key), padding: crypto.constants.RSA_PKCS1_PADDING }, parts[2], "base64");
  if (!verified) throw new Error("bad signature");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (clientId && payload.aud !== clientId) throw new Error("audience mismatch");
  if (!ISSUERS.includes(payload.iss)) throw new Error("bad issuer");
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error("token expired");
  if (!payload.sub) throw new Error("no subject");
  return payload;
}

function jwkToPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

function kv() {
  // Vercel KV (legacy) and marketplace Upstash Redis use different env names — accept both
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function kvGet(key) {
  const s = kv();
  if (!s) return { err: "KV_NOT_CONFIGURED" };
  const res = await fetch(`${s.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${s.token}` },
  });
  const j = await res.json();
  return { value: j.result ?? null };
}

async function kvSet(key, value) {
  const s = kv();
  if (!s) return { err: "KV_NOT_CONFIGURED" };
  const res = await fetch(`${s.url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return res.ok ? {} : { err: `KV_SET_${res.status}` };
}

function validatePresets(raw) {
  if (!Array.isArray(raw)) return "presets must be an array";
  if (raw.length > MAX_PRESETS) return `more than ${MAX_PRESETS} presets`;
  for (const p of raw) {
    if (!p || typeof p !== "object") return "preset must be an object";
    if (typeof p.id !== "string" || !/^[\w-]{1,40}$/.test(p.id)) return "bad preset id";
    if (typeof p.name !== "string" || p.name.trim().length < 1 || p.name.length > 60) return "bad preset name";
    if (JSON.stringify(p.view ?? {}).length > MAX_VIEW_BYTES) return `preset "${p.name}" view too large`;
  }
  return null;
}

export default async function handler(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  const token = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
  let user;
  try {
    user = await verifyGoogleIdToken(token);
  } catch (e) {
    res.writeHead(401, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: `unauthorized: ${e.message}` }));
  }

  const key = `preset:${user.sub}`;
  try {
    if (req.method === "GET") {
      const { value, err } = await kvGet(key);
      if (err) throw new Error(err);
      let presets = [];
      if (value) { try { presets = JSON.parse(value).presets ?? []; } catch { /* corrupt blob → reset */ } }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, presets, user: { name: user.name, email: user.email } }));
    }

    if (req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { throw new Error("invalid JSON body"); }
      const bad = validatePresets(body.presets);
      if (bad) throw new Error(bad);
      const { err } = await kvSet(key, JSON.stringify({ presets: body.presets, savedAt: new Date().toISOString() }));
      if (err) throw new Error(err);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, count: body.presets.length }));
    }

    res.writeHead(405, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
  } catch (e) {
    const status = e.message === "KV_NOT_CONFIGURED" ? 503 : 400;
    res.writeHead(status, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
