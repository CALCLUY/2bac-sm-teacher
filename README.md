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

The Node server only serves the static frontend and injects the API key into
`/config.js` at request time — the key itself lives in `.env` (gitignored) and is
never committed. The browser connects **directly** to Google (same approach as
Google's own web examples), which is required because the Live API does not
allow server-to-server proxying of the session from an arbitrary origin.

## Features

- ⌨️ Text chat with `gemini-3.8-live-extended-thinking`
- 🎙️ Real-time voice playback (raw 24 kHz/16-bit/mono PCM → Web Audio, queued with no gaps)
- 💬 Live streamed transcript shown next to the audio
- 💭 Extended-thinking summaries (collapsible "thinking" block)
- 🎚️ Voice picker (Puck, Kore, Charon, …) and thinking level (low / medium / high)
- 🔄 Session management: status pill (Live / Thinking… / Disconnected), New chat, auto-interrupt
  of a playing answer when you send a new message
- 🔑 Falls back to an in-browser key prompt (localStorage) if the server has no key

## Run

```bash
npm install
npm start          # → http://localhost:8080
```

Requires Node 18+ (22 recommended).

## Configuration (`.env`)

| Variable             | Default                                    | Meaning                                    |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| `GEMINI_API_KEY`     | —                                          | Your Gemini API key (AI Studio → Get key)  |
| `GEMINI_LIVE_MODEL`  | `gemini-3.8-live-extended-thinking`        | Live model to use                          |
| `PORT`               | `8080`                                     | Port for the web UI                        |

Create `.env` (already gitignored):

```
GEMINI_API_KEY=your-key-here
```

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
server.js              static host + /config.js key injection
public/index.html      chat UI
public/app.js          Live API client, PCM player, session management
public/styles.css      styling
scripts/test-live.js   CLI smoke test of the WebSocket protocol
.env                   API key (gitignored)
```
