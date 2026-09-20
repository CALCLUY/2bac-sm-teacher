/**
 * Gemini Live chatbot server.
 *
 * 1) Serves the static frontend (public/).
 * 2) Proxies the Gemini Live API WebSocket at /api/live:
 *        browser  <──wss──>  this server  <──wss──>  Google Live API
 *
 * The API key lives ONLY in .env (server-side). The browser never sees it.
 * This mirrors the architecture of the known-working reference app, because
 * the Live API silently ignores raw-API-key sessions opened directly from a
 * browser — server-to-server connections are the supported path.
 *
 *   node server.js   (or: npm start)
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY || '';
const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live-extended-thinking';
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SYSTEM_PROMPT =
  'You are a thoughtful, warm and concise conversational assistant. ' +
  'Your replies are spoken aloud at the same time they are shown as text, ' +
  'so keep them natural and conversational — usually one to three short paragraphs. ' +
  'Answer the user directly, with clear structure and a warm, natural speaking style. ' +
  'Avoid markdown, tables and code blocks in your spoken replies. ' +
  'Do not mention hidden reasoning or chain-of-thought; if a response is complex, ' +
  'summarize the key points instead. ' +
  'If the user writes in a language other than English, reply in that language.';

const app = express();

app.get('/config.js', (req, res) => {
  // Served by a real server => proxy mode (key stays on the server).
  const config = { apiKey: '', model: DEFAULT_MODEL, mode: 'proxy' };
  res
    .type('application/javascript')
    .send(`window.GEMINI_CONFIG = ${JSON.stringify(config)};`);
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gemini Live chatbot (proxy mode) on http://0.0.0.0:${PORT}`);
  if (!API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set — the Live session will fail.');
  }
});

/* ---------------- Live API WebSocket proxy ---------------- */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname !== '/api/live') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit('connection', client);
  });
});

wss.on('connection', (client) => {
  console.log('[proxy] client connected');
  let upstream = null;

  const sendToClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  };

  client.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (m.type === 'init' && (!upstream || upstream.readyState === WebSocket.CLOSED)) {
      if (!API_KEY) {
        sendToClient(JSON.stringify({ type: 'upstreamError', message: 'GEMINI_API_KEY is not set on the server.' }));
        client.close(1011, 'missing key');
        return;
      }
      const model = m.model || DEFAULT_MODEL;
      console.log(`[proxy] opening upstream for ${model} (voice: ${m.voiceName || 'default'}, thinking: ${m.thinkingLevel || 'n/a'})`);

      upstream = new WebSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(API_KEY)}`);

      upstream.on('open', () => {
        // Setup mirrors the known-working reference implementation.
        const gc = { responseModalities: ['AUDIO'] };
        if (model.includes('extended-thinking')) {
          gc.thinkingConfig = { thinkingLevel: m.thinkingLevel || 'medium' };
        }
        if (m.voiceName) {
          gc.speechConfig = {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: m.voiceName } },
          };
        }
        upstream.send(
          JSON.stringify({
            setup: {
              model: `models/${model}`,
              generationConfig: gc,
              systemInstruction: { parts: [{ text: m.systemPrompt || SYSTEM_PROMPT }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          })
        );
        console.log('[proxy] upstream open — setup sent');
      });

      // Relay Gemini -> browser verbatim.
      upstream.on('message', (data) => sendToClient(data.toString()));

      upstream.on('close', (code, reason) => {
        console.log(`[proxy] upstream closed (${code} ${reason.toString()})`);
        sendToClient(JSON.stringify({ type: 'upstreamClosed', code, reason: reason.toString() }));
      });

      upstream.on('error', (e) => {
        console.error('[proxy] upstream error', e.message);
        sendToClient(JSON.stringify({ type: 'upstreamError', message: e.message }));
      });
      return;
    }

    if (m.type === 'text' && m.text && upstream && upstream.readyState === WebSocket.OPEN) {
      // Same primitive as the working reference app.
      upstream.send(JSON.stringify({ realtimeInput: { text: m.text } }));
    }

    if (m.type === 'interrupt' && upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    }
  });

  client.on('close', () => {
    console.log('[proxy] client disconnected');
    try {
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
    } catch {
      /* ignore */
    }
  });
});
