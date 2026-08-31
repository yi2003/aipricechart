// Google OAuth Client ID for "Sign in with Google" (presets sync).
// Client IDs are public identifiers, safe to commit. Setup:
//   1. https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID
//   2. Type: Web application. Authorized JavaScript origins:
//        https://aipricechart.vercel.app
//        http://localhost:4173
//   3. Paste the ID below AND set GOOGLE_CLIENT_ID in Vercel → Settings → Environment Variables.
// Leave empty "" and the app simply stays anonymous-only (no sign-in button shown).
window.GOOGLE_CLIENT_ID = window.GOOGLE_CLIENT_ID || "403498956972-3jj51msmqe2vqo4mb43r5uafdpuv1hdq.apps.googleusercontent.com";
