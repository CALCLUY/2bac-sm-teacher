// Static config for the GitHub Pages deployment (no server on Pages).
//
// Leave apiKey empty here and add the key as a GitHub Actions secret instead
// (Settings → Secrets and variables → Actions → GEMINI_API_KEY) — the Pages
// build (scripts/build-static.js) will inject it at deploy time, so it never
// has to live in this public repo. If the key is still empty when the page
// loads, the app shows a one-time in-browser prompt (stored in localStorage).
window.GEMINI_CONFIG = {
  apiKey: "",
  model: "gemini-3.8-live-extended-thinking",
};
