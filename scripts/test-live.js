/**
 * CLI smoke test for the Gemini Live API (run on a machine with internet
 * access: `npm test`). Uses Node's built-in WebSocket client (Node >= 22).
 *
 * Mirrors the setup of the known-working reference implementation:
 * v1beta endpoint, no speechConfig, lowercase thinkingLevel, plain
 * realtimeInput text. Falls back to v1alpha if v1beta stays silent.
 */
require('dotenv').config();

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live-extended-thinking';
if (!key) {
  console.error('Set GEMINI_API_KEY in .env first.');
  process.exit(1);
}

const VERSIONS = ['v1beta', 'v1alpha'];
let versionIdx = 0;
let setupDone = false;
let audioBytes = 0;
let setupTimeout = null;

function connect() {
  const version = VERSIONS[versionIdx];
  const url =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  console.log(`\n=== attempting ${version} endpoint ===`);
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    console.log('connected to Gemini Live WS');
    const gc = { responseModalities: ['AUDIO'] };
    if (model.includes('extended-thinking')) gc.thinkingConfig = { thinkingLevel: 'high' };
    ws.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
        generationConfig: gc,
        systemInstruction: {
          parts: [{ text: 'You are a thoughtful, concise voice assistant.' }],
        },
        outputAudioTranscription: {},
      },
    }));
    setupTimeout = setTimeout(() => {
      console.log(`no setupComplete on ${version}`);
      ws.close();
    }, 8000);
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    if (msg.setupComplete) {
      setupDone = true;
      clearTimeout(setupTimeout);
      console.log('SETUP COMPLETE — session ready');
      ws.send(JSON.stringify({ realtimeInput: { text: 'Say hello in exactly one short sentence.' } }));
    }

    if (msg.googRpc) console.log('GOOG RPC:', JSON.stringify(msg.googRpc));
    if (msg.error) console.log('ERROR:', JSON.stringify(msg.error));
    if (msg.sessionEnd) console.log('SESSION END:', JSON.stringify(msg.sessionEnd));

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interactionStatus) console.log('interactionStatus:', sc.interactionStatus);
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data) {
          audioBytes += Math.floor(part.inlineData.data.length * 0.75);
          console.log(`audio chunk: ${part.inlineData.mimeType} (~${Math.floor((part.inlineData.data.length * 0.75) / 1024)} KB) thought=${sc.thought ?? 'n/a'}`);
        }
        if (part.text) console.log(part.thought ? 'thought: ' : 'text part: ', part.text);
      }
    }
    if (sc.outputTranscription?.text) process.stdout.write('transcript: ' + sc.outputTranscription.text);
    if (sc.turnComplete) console.log('\nTURN COMPLETE');
  });

  ws.addEventListener('close', (e) => {
    clearTimeout(setupTimeout);
    console.log(`closed code=${e.code} reason=${e.reason} (audio=${audioBytes}B)`);
    if (!setupDone && versionIdx + 1 < VERSIONS.length) {
      versionIdx++;
      setTimeout(connect, 300);
    } else {
      console.log(setupDone ? '\nOK — model works on this endpoint.' : '\nFAILED on all endpoints — key may lack Live API / model access.');
      process.exit(setupDone ? 0 : 1);
    }
  });
}

connect();
setTimeout(() => process.exit(2), 120000);
