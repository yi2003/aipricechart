/* token.js — manages the /api/refresh secret token.
   CLI:  node token.js            → print the current token
         node token.js rotate     → generate a new token (invalidates old cron jobs)
   Env override: REFRESH_TOKEN always wins over the file. */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKEN_PATH = path.join(__dirname, ".refresh-token");

function generate() {
  return crypto.randomBytes(24).toString("hex");
}

function writeToken(token) {
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* best effort */ }
}

function loadOrCreate() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing) return existing;
  } catch { /* not there yet */ }
  const token = generate();
  writeToken(token);
  return token;
}

function rotate() {
  const token = generate();
  writeToken(token);
  return token;
}

/* constant-time comparison (hash first so lengths never leak) */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

if (require.main === module) {
  if (process.argv[2] === "rotate") {
    console.log(rotate());
  } else {
    console.log(loadOrCreate());
  }
  process.exit(0);
}

module.exports = { loadOrCreate, rotate, safeEqual, TOKEN_PATH };
