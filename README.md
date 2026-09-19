# Gemini Live Chatbot — text in, text + voice out

A small web chatbot that talks to **`gemini-3.8-live-extended-thinking`** through the
[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) over a raw
WebSocket. You send **text** messages; Gemini answers with **spoken voice and live text at the same time**
(native-audio models only support `["AUDIO"]` response modality, so the text is the model's
`outputAudioTranscription`, streamed token by token while the audio plays).

```
browser ──(wss, api key in URL)──► Gemini Live API (v1beta)
    ▲                                    │
    │  24 kHz 16-bit PCM audio (base64)  │  streamed transcript
    └────────────────────────────────────┘
```

The browser connects **directly** to Google (same approach as Google's own web
examples), which is required because the Live API does not allow
server-to-server proxying of the session from an arbitrary origin.

## Features

- ⌨️ Text chat with `gemini-3.8-live-extended-thinking`
- 🎙️ Real-time voice playback (raw 24 kHz/16-bit/mono PCM → Web Audio, queued with no gaps)
- 💬 Live streamed transcript shown next to the audio
- 💭 Extended-thinking summaries (collapsible "thinking" block)
- 🎚️ Voice picker (Puck, Kore, Charon, …) and thinking level (low / medium / high)
- 🔄 Session management: status pill (Live / Thinking… / Disconnected), New chat, auto-interrupt
  of a playing answer when you send a new message
- 🔑 Falls back to an in-browser key prompt (localStorage) if no key is configured

## Where the API key comes from

The app reads `window.GEMINI_CONFIG` from `public/config.js`. In priority order:

1. **A GitHub Actions secret `GEMINI_API_KEY`** — if it exists, the Pages build
   (`scripts/build-static.js`) regenerates `config.js` with that key, so the
   secret never has to live in the repo. (Recommended for anything you keep.)
2. **The committed `public/config.js`** — used as-is when no secret is set.
   ⚠️ This repo is public, so any key committed there is visible to everyone.
   The value currently in the file is a personal **test** key; rotate it if it
   must not stay public.
3. **A one-time in-browser prompt** (stored in `localStorage`) — shown only if
   neither of the above provides a key.

To run the Node server locally with your own key without touching the committed
file, put it in `.env` (gitignored) instead — `server.js` overrides
`/config.js` at request time.

## Run locally

```bash
npm install
npm start          # → http://localhost:8080
```

Requires Node 18+ (22 recommended).

## Configuration

| Variable (`.env`, local only) | Default                             | Meaning                             |
| ----------------------------- | ----------------------------------- | ----------------------------------- |
| `GEMINI_API_KEY`              | —                                   | Your Gemini API key (AI Studio)     |
| `GEMINI_LIVE_MODEL`           | `gemini-3.8-live-extended-thinking` | Live model to use                   |
| `PORT`                        | `8080`                              | Port for the web UI                 |

`.env` is gitignored. The Pages deployment is configured separately (below).

## Host on GitHub Pages (from this branch, not main)

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) builds the
static site and deploys it to GitHub Pages **from this branch**.

One-time setup you must do in the UI (the automation token here can't toggle
Pages for you):

1. Repo → **Settings → Pages**.
2. **Build and deployment → Source:** *Deploy from a branch*.
3. Pick branch `arena/01a0bc04-2bac-sm-teacher`, path `/`, **Save**.
4. Push (or use *Actions → Run workflow*) to trigger the first deploy.

Site URL: `https://<owner>.github.io/2bac-sm-teacher/`

The workflow:
- `scripts/build-static.js` → copies `public/` into `build/`, and if a
  `GEMINI_API_KEY` secret is set, writes `build/config.js` from it.
- `actions/upload-pages-artifact` + `actions/deploy-pages` → publish.

## Notes & limits

- Audio-only Live sessions are capped at **15 minutes** — the app shows a "Disconnected"
  state and "New chat" starts a fresh session (context resets).
- Extended-thinking models do background reasoning: while it works, the session reports
  `interactionStatus: IN_PROGRESS` and `turnComplete` alone does not mean idle — the UI
  accounts for that.
- Voice output is always 24 kHz 16-bit little-endian mono PCM from the Live API.
- Test the raw protocol from a terminal (needs internet): `npm test`.

## Layout

```
.github/workflows/deploy-pages.yml  CI build + Pages deploy (this branch)
server.js                           local static host + /config.js key injection
public/index.html                   chat UI
public/app.js                       Live API client, PCM player, session management
public/styles.css                   styling
public/config.js                    committed key/model for the Pages build
scripts/build-static.js             static build for GitHub Pages
scripts/test-live.js                CLI smoke test of the WebSocket protocol
.env                                local API key (gitignored)
```
