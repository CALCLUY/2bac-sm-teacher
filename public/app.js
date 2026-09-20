/* ============================================================
   Gemini Live chatbot — text in, text + voice out
   Talks to the Gemini Live API over a direct WebSocket
   (wss://generativelanguage.googleapis.com — tries v1alpha, then v1beta).
   Protocol reference: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
   ============================================================ */

const CFG = window.GEMINI_CONFIG || {};
const APP_VERSION = '6';
let MODEL = CFG.model || 'gemini-3.8-live-extended-thinking';
let API_KEY = CFG.apiKey || localStorage.getItem('gemini_api_key') || '';

// v1beta is the proven endpoint (matches the working reference app);
// v1alpha is kept as a fallback.
const API_VERSIONS = ['v1beta', 'v1alpha'];
const SETUP_TIMEOUT_MS = 8000; // per-attempt: fail fast and fall back

const WS_URL = (version) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(API_KEY)}`;

const SYSTEM_PROMPT =
  'You are a thoughtful, warm and concise conversational assistant. ' +
  'Your replies are spoken aloud at the same time they are shown as text, ' +
  'so keep them natural and conversational — usually one to three short paragraphs. ' +
  'Answer the user directly, with clear structure and a warm, natural speaking style. ' +
  'Avoid markdown, tables and code blocks in your spoken replies. ' +
  'Do not mention hidden reasoning or chain-of-thought; if a response is complex, ' +
  'summarize the key points instead. ' +
  'If the user writes in a language other than English, reply in that language.';

/* ---------------- state ---------------- */
let ws = null;
let ready = false;          // setupComplete received
let current = null;         // live bot message being built
let closedByUs = false;
let sendCount = 0;
let setupTimeout = null;
let versionAttempt = 0;     // index into API_VERSIONS
let fallbackPending = false; // suppress "session closed" toast for intentional fallback closes
let turnAudioChunks = 0;
let turnTranscriptChars = 0;

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const statusPill = $('statusPill');
const statusText = $('statusText');
const input = $('input');
const sendBtn = $('sendBtn');
const modelSelect = $('modelSelect');
const voiceSelect = $('voiceSelect');
const thinkingSelect = $('thinkingSelect');
$('modelTag').textContent = MODEL + '  ·  v' + APP_VERSION;
if (modelSelect) {
  modelSelect.value = MODEL;
  thinkingSelect.disabled = !MODEL.includes('extended-thinking');
}
$('diagVersion').textContent = 'v' + APP_VERSION;

/* ---------------- diagnostics (in-page, no devtools needed) ---------------- */
const diagList = $('diagList');
const diagBox = $('diagBox');
function diag(msg, kind) {
  const line = document.createElement('div');
  if (kind) line.className = 'diag-' + kind;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  diagList.appendChild(line);
  while (diagList.children.length > 40) diagList.firstChild.remove();
  diagList.scrollTop = diagList.scrollHeight;
  console.log('[diag]', msg);
}
function diagFail(msg) {
  diag(msg, 'err');
  diagBox.open = true;
}

/* ---------------- PCM audio player (16-bit, 24 kHz, mono) ---------------- */
class PcmPlayer {
  constructor(sampleRate) {
    this.rate = sampleRate;
    this.ctx = null;
    this.queue = [];
    this.src = null;
    this.nextTime = 0;
    this.onActivity = null;
  }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  push(arrayBuffer) {
    const ctx = this.ensure();
    const int16 = new Int16Array(arrayBuffer);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = ctx.createBuffer(1, Math.max(1, f32.length), this.rate);
    buf.getChannelData(0).set(f32);
    this.queue.push(buf);
    this.pump();
  }
  pump() {
    if (this.src || this.queue.length === 0) return;
    const ctx = this.ensure();
    const buf = this.queue.shift();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = Math.max(ctx.currentTime + 0.02, this.nextTime);
    this.nextTime = t0 + buf.duration;
    src.onended = () => {
      if (this.src === src) {
        this.src = null;
        this.pump();
        if (this.queue.length === 0) { this.nextTime = 0; this.onActivity && this.onActivity(false); }
      }
    };
    this.src = src;
    src.start(t0);
    this.onActivity && this.onActivity(true);
  }
  stop() {
    this.queue = [];
    if (this.src) {
      const s = this.src; this.src = null;
      s.onended = null;
      try { s.stop(); } catch (e) { /* already stopped */ }
    }
    this.nextTime = 0;
    this.onActivity && this.onActivity(false);
  }
}

const player = new PcmPlayer(24000); // Live API audio output is always 24 kHz / 16-bit / mono

let audioDiagnosed = false;
player.onActivity = (speaking) => {
  if (current) current.el.querySelector('.eq').classList.toggle('active', speaking);
  if (!speaking) {
    document.body.classList.remove('speaking');
  } else {
    document.body.classList.add('speaking');
    if (!audioDiagnosed) {
      audioDiagnosed = true;
      diag(`audio playing (AudioContext state: ${player.ctx ? player.ctx.state : 'n/a'})`, 'ok');
    }
  }
};

/* ---------------- helpers ---------------- */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function setStatus(kind) {
  statusPill.className = 'status-pill ' + kind;
  const labels = {
    connecting: 'Connecting…',
    live: 'Live',
    working: 'Thinking…',
    disconnected: 'Disconnected',
    error: 'Error',
    nokey: 'API key needed',
    timeout: 'Setup timeout',
  };
  statusText.textContent = labels[kind] || kind;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollDown();
}

function ensureBotMessage() {
  if (current && !current.finalized) return current;
  current = { transcript: '', text: '', thoughts: '', finalized: false };
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = `
    <div class="avatar">✦</div>
    <div class="bubble">
      <div class="thoughts" hidden><div class="thoughts-label">💭 thinking</div><div class="thoughts-text"></div></div>
      <div class="text"></div>
      <div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
    </div>`;
  messagesEl.appendChild(wrap);
  current.el = wrap;
  return current;
}

function renderCurrent() {
  if (!current || !current.el) return;
  const body = current.transcript || current.text;
  current.el.querySelector('.text').textContent = body;
  const thoughts = current.el.querySelector('.thoughts');
  const thoughtsText = current.el.querySelector('.thoughts-text');
  if (current.thoughts) {
    thoughts.hidden = false;
    thoughtsText.textContent = current.thoughts;
  }
  scrollDown();
}

function finalizeCurrent() {
  if (!current) return;
  // Prefer the full text parts if the model sent them; otherwise keep the transcript.
  if (current.text && !current.transcript) {
    current.el.querySelector('.text').textContent = current.text;
  }
  if (current.finalized) return;
  current.finalized = true;
  setTimeout(() => { if (current && current.finalized) { current.el.querySelector('.eq').classList.remove('active'); } }, 400);
}

function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled;
  input.disabled = !enabled;
}

/* ---------------- session ---------------- */
function buildSetup() {
  const gc = {
    // Native-audio models respond in AUDIO only; the text arrives as
    // outputAudioTranscription (spoken text, streamed live).
    responseModalities: ['AUDIO'],
  };
  // thinkingLevel is only supported (and only valid) on the
  // extended-thinking model — it MUST be omitted for gemini-3.8-live.
  // (lowercase values, as accepted by the Live API — see the working
  // reference app which sends thinkingLevel: "high")
  if (isThinkingModel()) {
    gc.thinkingConfig = {
      thinkingLevel: thinkingSelect.value, // low | medium | high
    };
  }
  // Voice config is OPTIONAL: the working reference app sends none and
  // uses the default voice. Some voices may not exist for this model,
  // in which case the setup is silently rejected — so "Default" is the
  // safe choice and the recommended one.
  if (voiceSelect.value) {
    gc.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voiceSelect.value },
      },
    };
  }
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: gc,
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    },
  };
}

function isThinkingModel() {
  return MODEL.includes('extended-thinking');
}

function connect() {
  if (!API_KEY) { setStatus('nokey'); toast('Add your Gemini API key in the header to start.', 'error'); return; }

  closedByUs = false;
  setStatus('connecting');
  setSendEnabled(false);
  current = null;
  versionAttempt = 0;
  openSocket();
}

function openSocket() {
  const version = API_VERSIONS[versionAttempt];
  const socket = new WebSocket(WS_URL(version));
  ws = socket;
  fallbackPending = false;
  diag(`attempting ${version} endpoint (model: ${MODEL})`);
  console.log(`[live] attempting ${version} endpoint for models/${MODEL}`);

  socket.onopen = () => {
    console.log('[live] WebSocket open, sending setup');
    const setup = buildSetup();
    console.log('[live] setup ->', JSON.stringify(setup));
    diag(`ws open — setup sent (voice: ${voiceSelect.value || 'default'}, thinking: ${isThinkingModel() ? thinkingSelect.value : 'n/a'})`, 'ok');
    socket.send(JSON.stringify(setup));

    setupTimeout = setTimeout(() => {
      if (!ready && isCurrent()) {
        console.error(`[live] no setupComplete on ${version} — falling back`);
        fallbackPending = true; // this close is intentional; don't toast "session closed"
        try { socket.close(); } catch (e) { /* ignore */ }
        versionAttempt++;
        if (versionAttempt < API_VERSIONS.length) {
          setStatus('connecting');
          diagFail(`no setupComplete on ${version} — retrying with ${API_VERSIONS[versionAttempt]}…`);
          toast(`No session on ${version} — retrying with ${API_VERSIONS[versionAttempt]}…`, 'info');
          setTimeout(openSocket, 300);
        } else {
          fallbackPending = false;
          setStatus('error');
          diagFail(`setup timed out on ALL endpoints (${API_VERSIONS.join(', ')})`);
          toast(
            `Setup timed out on every API version (${API_VERSIONS.join(', ')}). ` +
            'Try the other model in the header — if that also fails, the API key ' +
            'likely has no access to the Gemini Live API (check AI Studio).',
            'error'
          );
        }
      }
    }, SETUP_TIMEOUT_MS);
  };

  // Guards: a replaced (superseded) socket must not touch shared state.
  const isCurrent = () => ws === socket;

  socket.onmessage = (event) => {
    if (!isCurrent()) return;
    let m;
    try { m = JSON.parse(event.data); } catch (e) { console.warn('[live] non-JSON message', e); return; }

    const sc = m.serverContent;
    if (m.setupComplete) diag('recv: setupComplete', 'ok');
    else if (m.googRpc) diagFail(`recv: GOOGLE ERROR ${m.googRpc.code || ''}: ${m.googRpc.message || 'unknown'}`);
    else if (m.error) diagFail('recv: ERROR ' + (m.error.message || JSON.stringify(m.error)));
    else if (m.sessionEnd) diag('recv: sessionEnd');
    else if (sc) {
      turnAudioChunks += (sc.modelTurn?.parts || []).filter(p => p.inlineData?.data).length;
      if (sc.outputTranscription?.text) turnTranscriptChars += sc.outputTranscription.text.length;
      if (sc.thought) diag('recv: thought summary');
      if (sc.interrupted) diag('recv: interrupted');
      if (sc.interactionStatus) diag('interactionStatus: ' + sc.interactionStatus);
      if (sc.turnComplete) diag(`recv: turnComplete (audio chunks: ${turnAudioChunks}, transcript chars: ${turnTranscriptChars})`, 'ok');
    }
    console.log('[live] <-', m.setupComplete ? 'setupComplete' : Object.keys(m).join(','), m);
    handleServerMessage(m);
  };

  socket.onerror = (e) => {
    console.error('[live] WebSocket error', e);
    if (isCurrent()) {
      clearTimeout(setupTimeout);
      setStatus('error');
      diagFail('ws error — check API key / network');
      toast('Connection error — check your API key / network.', 'error');
    }
  };

  socket.onclose = (event) => {
    console.log('[live] WebSocket closed', event.code, event.reason.toString());
    clearTimeout(setupTimeout);
    diag(`ws closed (code ${event.code}${event.reason ? ': ' + event.reason : ''})`);
    if (!isCurrent()) return; // superseded by a newer session
    ready = false;
    setSendEnabled(false);
    player.stop();
    if (current) finalizeCurrent();
    if (!closedByUs && !fallbackPending) {
      setStatus('disconnected');
      toast(`Session closed (${event.code}). Click “New chat” to reconnect.`, 'info');
    }
    ws = null;
  };
}

function handleServerMessage(m) {
  if (m.googRpc) {
    console.error('[live] googRpc', m.googRpc);
    setStatus('error');
    toast(`Google API error ${m.googRpc.code || ''}: ${m.googRpc.message || 'unknown'}`, 'error');
    return;
  }
  if (m.error) {
    console.error('[live] error', m.error);
    toast(`Error: ${m.error.message || JSON.stringify(m.error)}`, 'error');
    return;
  }
  if (m.setupComplete) {
    ready = true;
    clearTimeout(setupTimeout);
    setStatus('live');
    setSendEnabled(true);
    diag('setupComplete — session READY', 'ok');
    console.log('[live] setup complete — session ready');
    return;
  }
  if (m.sessionEnd) {
    ready = false;
    setSendEnabled(false);
    toast('The server ended the session. Click “New chat” to start again.', 'info');
    return;
  }

  const sc = m.serverContent;
  if (!sc) return;

  // Extended-thinking models do async background reasoning:
  // turnComplete alone may not mean the session is idle — use interactionStatus.
  const ist = sc.interactionStatus || m.interactionStatus || '';
  if (String(ist).includes('IN_PROGRESS')) setStatus('working');
  else if (String(ist).includes('IDLE')) setStatus(ready ? 'live' : 'disconnected');

  if (sc.interrupted) {
    console.log('[live] generation interrupted');
    player.stop();
    finalizeCurrent();
    current = null;
    setStatus(ready ? 'live' : 'disconnected');
    return;
  }

  if (sc.thought) {
    ensureBotMessage();
    current.el.querySelector('.thoughts').hidden = false;
  }

  if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
    for (const part of sc.modelTurn.parts) {
      if (part.inlineData && part.inlineData.data) {
        // Raw PCM audio chunk (24 kHz / 16-bit / mono, base64)
        ensureBotMessage();
        try { player.push(base64ToBytes(part.inlineData.data)); }
        catch (e) { console.warn('[live] failed to decode audio chunk', e); }
      } else if (typeof part.text === 'string' && part.text) {
        ensureBotMessage();
        if (part.thought || sc.thought) current.thoughts += part.text;
        else current.text += part.text;
        renderCurrent();
      }
    }
  }

  // Transcription of the spoken audio — this is the streamed text answer.
  if (sc.outputTranscription && sc.outputTranscription.text) {
    ensureBotMessage();
    current.transcript += sc.outputTranscription.text;
    renderCurrent();
  }

  if (sc.turnComplete) {
    console.log('[live] turn complete');
    finalizeCurrent();
    setStatus(ready ? 'live' : 'disconnected');
    setSendEnabled(true);
  }
}

function sendText(text) {
  text = text.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN || !ready) {
    toast('Session is not ready yet — try again in a moment.', 'error');
    return;
  }
  // Wake the AudioContext on a user gesture (browser autoplay policy)
  player.ensure();
  player.stop(); // interrupt any still-playing answer

  addUserMessage(text);
  current = null;
  sendCount++;
  turnAudioChunks = 0;
  turnTranscriptChars = 0;
  audioDiagnosed = false;
  setStatus('working');

  // Same primitive as the working reference app: plain realtimeInput text.
  const msg = { realtimeInput: { text } };
  ws.send(JSON.stringify(msg));
  diag(`sent text turn #${sendCount}`);
  input.value = '';
  autoresize();
  console.log('[live] sent text turn #%d', sendCount);
}

function restartSession(label) {
  closedByUs = true;
  if (ws) { try { ws.close(); } catch (e) {} }
  current = null;
  player.stop();
  setStatus('connecting');
  setSendEnabled(false);
  setTimeout(() => {
    if (label) toast(label, 'info');
    connect();
  }, 150);
}

function newChat() {
  messagesEl.innerHTML = '';
  addWelcome();
  restartSession('Fresh conversation started.');
}

function addWelcome() {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = `
    <div class="avatar">✦</div>
    <div class="bubble">
      <div class="text">Hi! I’m Gemini, running on ${MODEL}. Ask me anything — I’ll reply with both text and my voice. 🎙️</div>
    </div>`;
  messagesEl.appendChild(wrap);
  scrollDown();
}

/* ---------------- UI wiring ---------------- */
function autoresize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

sendBtn.addEventListener('click', () => sendText(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText(input.value);
  }
});
input.addEventListener('input', autoresize);
$('newChatBtn').addEventListener('click', newChat);
modelSelect.addEventListener('change', () => {
  MODEL = modelSelect.value;
  $('modelTag').textContent = MODEL;
  thinkingSelect.disabled = !MODEL.includes('extended-thinking');
  restartSession(`Model set to ${MODEL} (new session).`);
});
voiceSelect.addEventListener('change', () => restartSession(
  voiceSelect.value
    ? `Voice set to “${voiceSelect.value}” (new session). If it can't connect, switch back to Default.`
    : 'Voice set to Default (model built-in voice). New session.'
));
thinkingSelect.addEventListener('change', () => restartSession(`Thinking level: ${thinkingSelect.value} (new session).`));

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (!ready) { toast('Waiting for the session to be ready…', 'error'); return; }
    sendText(chip.dataset.q);
    $('suggestions').style.display = 'none';
  });
});

// Unlock audio on first interaction (mobile autoplay policy)
document.addEventListener('pointerdown', () => player.ensure(), { once: true });

/* ---------------- boot ---------------- */
console.log(`[live] app v${APP_VERSION} loaded`);
if (!API_KEY) {
  // Ask for a key inline (only when the server didn't provide one)
  setStatus('nokey');
  diag('app v' + APP_VERSION + ' loaded — NO key configured; using in-browser prompt', 'err');
  const keyWrap = document.createElement('div');
  keyWrap.className = 'key-ask';
  keyWrap.innerHTML = `
    <div class="key-ask-inner">
      <div class="key-ask-title">✦ Add your Gemini API key</div>
      <div class="key-ask-sub">It’s sent only to Google’s Live API and stored in this browser (localStorage).</div>
      <input type="password" id="keyInput" placeholder="AIza… or AQ.…" />
      <button id="keyBtn">Start chat</button>
    </div>`;
  document.body.appendChild(keyWrap);
  const keyInput = keyWrap.querySelector('#keyInput');
  keyWrap.querySelector('#keyBtn').addEventListener('click', submitKey);
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && submitKey());
  function submitKey() {
    const k = keyInput.value.trim();
    if (!k) return;
    API_KEY = k;
    localStorage.setItem('gemini_api_key', k);
    keyWrap.remove();
    diag('key entered via browser prompt (stored in localStorage)', 'ok');
    connect();
  }
} else {
  diag(`app v${APP_VERSION} loaded — key from ${CFG.apiKey ? 'config.js' : 'localStorage'}`, 'ok');
  addWelcome();
  connect();
}
