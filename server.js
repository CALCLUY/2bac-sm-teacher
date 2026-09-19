const path = require('path');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * Serves runtime config (API key + model) to the browser.
 * The key lives in .env (gitignored) — it is never stored in source files.
 */
app.get('/config.js', (req, res) => {
  const config = {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live-extended-thinking',
  };
  res.type('application/javascript').send(`window.GEMINI_CONFIG = ${JSON.stringify(config)};`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gemini Live chatbot running on http://0.0.0.0:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set — the UI will ask the user for a key.');
  }
});
