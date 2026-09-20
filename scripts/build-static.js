/**
 * Static build for GitHub Pages.
 *
 * Copies public/ into build/. If GEMINI_API_KEY is set in the environment
 * (e.g. from a GitHub Actions secret) it regenerates config.js with that key;
 * otherwise the committed public/config.js is kept as-is.
 *
 *   node scripts/build-static.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build');

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), outDir, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || '';
const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live-extended-thinking';

if (apiKey) {
  fs.writeFileSync(
    path.join(outDir, 'config.js'),
    `window.GEMINI_CONFIG = ${JSON.stringify({ apiKey, model })};\n`
  );
  console.log(`Built static site into ${outDir} (apiKey injected from env, model=${model})`);
} else {
  console.log(`Built static site into ${outDir} (using committed public/config.js, model=${model})`);
}
