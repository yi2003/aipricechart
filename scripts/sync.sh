#!/usr/bin/env bash
# Refresh prices, validate, and push to GitHub (triggers Vercel auto-deploy).
# Requires: the app server running locally (npm start / @reboot cron), git remote configured.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[$(date -u '+%F %T UTC')] refreshing…"
curl -sf -X POST http://localhost:4173/api/refresh \
  -H "Authorization: Bearer $(cat .refresh-token)" \
  -o logs/refresh-last.json

# validation gate: never push broken data
node -e "
const r = require('./logs/refresh-last.json');
if (!r.ok) { console.error('refresh failed:', r.error || 'unknown'); process.exit(1); }
if (r.validation.errors.length) {
  console.error('VALIDATION ERRORS — not pushing:');
  r.validation.errors.forEach(e => console.error('  -', e));
  process.exit(1);
}
console.log('validated:', r.models, 'models,', r.changes.length, 'changes',
  '| suspicious:', r.validation.suspicious.length, '| warnings:', r.validation.warnings.length);
r.validation.suspicious.forEach(s =>
  console.warn('  ⚠ ' + s.model + ' ' + s.field + ': ' + s.from + ' → ' + s.to + (s.pct ? ' (' + s.pct + '%)' : '')));
"

git add data/models.js
if git diff --cached --quiet; then
  echo "no price changes — nothing to push"
else
  git commit -q -m "chore: refresh prices $(date -u +%F)"
  git push -q origin main
  echo "pushed → Vercel will auto-deploy"
fi
