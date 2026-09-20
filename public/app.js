/* ============================================================
   Gemini Live chatbot — text in, text + voice out
   Talks to the Gemini Live API over a direct WebSocket
   (wss://generativelanguage.googleapis.com — v1beta).
   Protocol reference: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
   ============================================================ */

const CFG = window.GEMINI_CONFIG || {};
const MODEL = CFG.model || 'gemini-3.8-live-extended-thinking';
let API_KEY = CFG.apiKey || localStorage.getItem('gemini_api_key') || '';

const WS_URL = () =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(API_KEY)}`;

const SYSTEM_PROMPT =
  'You are Gemini, a warm, friendly, and concise conversational chatbot. ' +
  'Your replies are spoken aloud at the same time they are shown as text, ' +
  'so keep them natural and conversational — usually one to three short paragraphs. ' +
  'Avoid markdown, tables and code blocks in your spoken replies. ' +
  'If the user writes in a language other than English, reply in that language.';

/* ---------------- state ---------------- */
let ws = null;
let ready = false;          // setupComplete received
let current = null;         // live bot message being built
let closedByUs = false;
let sendCount = 0;
let setupTimeout = null;
const SETUP_TIMEOUT_MS = 20000; // fail loudly if setupComplete never arrives

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const statusPill = $('statusPill');
const statusText = $('statusText');
const input = $('input');
const sendBtn = $('sendBtn');
const voiceSelect = $('voiceSelect');
const thinkingSelect = $('thinkingSelect');
$('modelTag').textContent = MODEL;

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

player.onActivity = (speaking) => {
  if (current) current.el.querySelector('.eq').classList.toggle('active', speaking);
  if (!speaking) {
    document.body.classList.remove('speaking');
  } else {
    document.body.classList.add('speaking');
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
function connect() {
  if (!API_KEY) { setStatus('nokey'); toast('Add your Gemini API key in the header to start.', 'error'); return; }

  closedByUs = false;
  setStatus('connecting');
  setSendEnabled(false);
  current = null;

  const socket = new WebSocket(WS_URL());
  ws = socket;

  socket.onopen = () => {
    console.log('[live] WebSocket open, sending setup');
    // Match the raw-protocol setup for this model exactly (see
    // https://ai.google.dev/gemini-api/docs/live-api/thinking — “Step 1:
    // Session setup”): enum values on the wire are UPPERCASE, and native
    // audio models only support ["AUDIO"] (text arrives as
    // outputAudioTranscription).
    const setup = {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceSelect.value },
            },
          },
          thinkingConfig: {
            thinkingLevel: thinkingSelect.value.toUpperCase(), // LOW | MEDIUM | HIGH
          },
        },
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      },
    };
    console.log('[live] setup ->', JSON.stringify(setup));
    socket.send(JSON.stringify(setup));

    setupTimeout = setTimeout(() => {
      if (!ready && isCurrent()) {
        console.error('[live] setupComplete never arrived — closing');
        setStatus('timeout');
        toast(
          'The session never confirmed setup (check the browser console). Click “New chat” to retry.',
          'error'
        );
        try { socket.close(); } catch (e) { /* ignore */ }
      }
    }, SETUP_TIMEOUT_MS);
  };

  // Guards: a replaced (superseded) socket must not touch shared state.
  const isCurrent = () => ws === socket;

  socket.onmessage = (event) => {
    if (!isCurrent()) return;
    let m;
    try { m = JSON.parse(event.data); } catch (e) { console.warn('[live] non-JSON message', e); return; }
    console.log('[live] <-', m.setupComplete ? 'setupComplete' : Object.keys(m).join(','), m);
    handleServerMessage(m);
  };

  socket.onerror = (e) => {
    console.error('[live] WebSocket error', e);
    if (isCurrent()) {
      clearTimeout(setupTimeout);
      setStatus('error');
      toast('Connection error — check your API key / network.', 'error');
    }
  };

  socket.onclose = (event) => {
    console.log('[live] WebSocket closed', event.code, event.reason.toString());
    clearTimeout(setupTimeout);
    if (!isCurrent()) return; // superseded by a newer session
    ready = false;
    setSendEnabled(false);
    player.stop();
    if (current) finalizeCurrent();
    if (!closedByUs) {
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
  setStatus('working');

  const msg = {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true, // text-only chat: the whole turn in one message
    },
  };
  ws.send(JSON.stringify(msg));
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
voiceSelect.addEventListener('change', () => restartSession(`Voice set to “${voiceSelect.value}” (new session).`));
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
if (!API_KEY) {
  // Ask for a key inline (only when the server didn't provide one)
  setStatus('nokey');
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
    connect();
  }
} else {
  addWelcome();
  connect();
}
