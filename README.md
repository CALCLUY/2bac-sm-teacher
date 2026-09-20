# Gemini Live Chatbot — text in, text + voice out

A small web chatbot that talks to **`gemini-3.8-live-extended-thinking`** through the
[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
You send **text** messages; Gemini answers with **spoken voice and live text at the same time**
(native-audio models only support `["AUDIO"]` response modality, so the text is the model's
`outputAudioTranscription`, streamed token by token while the audio plays).

## Architecture (why there is a proxy)

```
browser  ──(wss)──►  this server  ──(wss, api key)──►  Gemini Live API (v1beta)
    ▲
    │  24 kHz 16-bit PCM audio (base64)  +  streamed transcript
    └───────────────────────────────────────────────┘
```

The browser talks to **`/api/live` on this server**, which opens the real
`wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent` socket
server-side and relays messages both ways. The API key lives **only** in the
server environment (`.env` / platform env vars) — it never reaches the browser.

This is the same architecture as the proven-working `gemini-voice-chat` app,
and it is required in practice: the Live API **silently drops raw-API-key
sessions opened directly from a browser** (the WebSocket opens, the setup is
sent, and Google never answers — verified with the in-page diagnostics). The
same setup works fine from a Node server. The capabilities doc states the
Live API is server-to-server by default.

The app supports two modes, chosen by `window.GEMINI_CONFIG.mode`:

- **`proxy`** (served by `server.js`) — the supported path above. No key
  prompt, no key in the browser.
- **`direct`** (static GitHub Pages build) — the browser connects straight to
  Google with a key from `config.js`/localStorage. Kept as a fallback/demo;
  it works only where Google allows browser-origin raw-key sessions.

## Features

- ⌨️ Text chat with `gemini-3.8-live-extended-thinking`
- 🎙️ Real-time voice playback (raw 24 kHz/16-bit/mono PCM → Web Audio, queued with no gaps)
- 💬 Live streamed transcript shown next to the audio
- 💭 Extended-thinking summaries (collapsible "thinking" block)
- 🎚️ Voice picker (Default recommended) and thinking level (low / medium / high)
- 🔄 Session management: status pill (Live / Thinking… / Disconnected), New chat, auto-interrupt
  of a playing answer when you send a new message
- 🩺 In-page diagnostics box (bottom of the page) — no DevTools needed
- 🔑 Direct mode falls back to an in-browser key prompt (localStorage)

## Where the API key comes from

- **Proxy mode:** `GEMINI_API_KEY` environment variable on the server
  (`.env` locally, platform env vars when hosted). It is sent only to Google
  by the server, never to the browser.
- **Direct mode (Pages):** `window.GEMINI_CONFIG` from `config.js` —
  a GitHub Actions secret `GEMINI_API_KEY` is injected at build time if set,
  otherwise a one-time in-browser prompt (stored in `localStorage`).
  ⚠️ This repo is public — anything committed to `public/config.js` is visible
  to everyone.

## Run locally

```bash
npm install
npm start          # → http://localhost:8080  (proxy mode, reads .env)
```

Create `.env` (gitignored) first:

```
GEMINI_API_KEY=your-key
GEMINI_LIVE_MODEL=gemini-3.8-live-extended-thinking
PORT=8080
```

Requires Node 18+ (22 recommended).

## Deploy it (recommended: any Node host)

GitHub Pages **cannot run the proxy**, so the working deployment is a Node
server — the easiest option is the same host you already use for
`gemini-voice-chat`, or any PaaS:

**Render / Railway / Fly.io / VPS — any of them:**

1. Push this branch (`arena/01a0bc04-2bac-sm-teacher`) to a repo the host
   watches, or clone it.
2. `npm install`
3. Set the environment variable **`GEMINI_API_KEY`**
   (optionally `GEMINI_LIVE_MODEL`, `PORT`).
4. Start command: **`npm start`** (or `node server.js`).
   On PaaS platforms that assign the port (Render: `$PORT`, Railway: `PORT`),
   the server picks it up automatically.
5. Open the assigned URL — the page runs in proxy mode with no key prompt.

Then point your browser at that URL (or, if you keep the Pages site, set
`proxyUrl` in its `config.js` to `https://<your-host>/api/live` — the static
build will then talk to your remote proxy).

### GitHub Pages (static, direct mode — demo only)

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) builds the
static site and deploys it to GitHub Pages **from this branch** (not main).
One-time setup you must do in the UI:

1. Repo → **Settings → Pages** → **Build and deployment → Source:** *Deploy from a branch*.
2. Branch `arena/01a0bc04-2bac-sm-teacher`, path `/`, **Save**.

Site URL: `https://<owner>.github.io/2bac-sm-teacher/`

The workflow:
- `scripts/build-static.js` → copies `public/` into `build/`, and if a
  `GEMINI_API_KEY` secret is set, writes `build/config.js` from it.
- `actions/upload-pages-artifact` + `actions/deploy-pages` → publish.

Because Pages is static, the hosted page runs in **direct mode** (browser →
Google), which is the path Google currently drops for raw API keys — expect
the diagnostics box to explain the situation if it fails. The real
experience is the Node-hosted proxy above.

## Configuration

| Variable | Where      | Default                             | Meaning                             |
| -------- | ---------- | ----------------------------------- | ----------------------------------- |
| `GEMINI_API_KEY` | server env / `.env` / Actions secret | — | Your Gemini API key (AI Studio) |
| `GEMINI_LIVE_MODEL` | server env / `.env` | `gemini-3.8-live-extended-thinking` | Live model to use |
| `PORT` | server env / `.env` | `8080` | Port for the web UI (auto on PaaS) |

## Notes & limits

- Audio-only Live sessions are capped at **15 minutes** — the app shows a "Disconnected"
  state and "New chat" starts a fresh session (context resets).
- Extended-thinking models do background reasoning: while it works, the session reports
  `interactionStatus: IN_PROGRESS` and `turnComplete` alone does not mean idle — the UI
  accounts for that.
- Voice output is always 24 kHz 16-bit little-endian mono PCM from the Live API.
- The upstream session setup mirrors the working `gemini-voice-chat` protocol exactly
  (v1beta endpoint, `responseModalities: ["AUDIO"]`, `thinkingLevel` in lowercase,
  `inputAudioTranscription`/`outputAudioTranscription`, `realtimeInput.text` messages,
  no `speechConfig` when "Default" voice is selected).
- Test the raw protocol from a terminal (needs internet + `GEMINI_API_KEY`): `npm test`.

## Layout

```
.github/workflows/deploy-pages.yml  CI build + Pages deploy (this branch, static/direct mode)
server.js                           web server: static files + /api/live Live-API proxy (proxy mode)
public/index.html                   chat UI
public/app.js                       Live client (proxy + direct modes), PCM player, diagnostics
public/styles.css                   styling
public/config.js                    committed config template (Pages/direct mode)
scripts/build-static.js             static build for GitHub Pages
scripts/test-live.js                CLI smoke test of the WebSocket protocol
.env                                local API key (gitignored)
```
