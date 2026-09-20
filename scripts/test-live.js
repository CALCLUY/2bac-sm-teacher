/**
 * CLI smoke test for the Gemini Live API (run on a machine with internet access:
 * `npm test`). Uses Node's built-in WebSocket client (Node >= 22).
 *
 * Connects, configures a TEXT+AUDIO session for the extended-thinking live model,
 * sends one text turn, and prints the audio chunks + streamed transcript.
 */
require('dotenv').config();

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live-extended-thinking';
if (!key) {
  console.error('Set GEMINI_API_KEY in .env first.');
  process.exit(1);
}

const url =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;

const ws = new WebSocket(url);
let audioBytes = 0;

ws.addEventListener('open', () => {
  console.log('connected to Gemini Live WS');
  ws.send(
    JSON.stringify({
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 1.0,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          thinkingConfig: { thinkingLevel: 'MEDIUM' },
        },
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: 'You are a friendly, concise chatbot.' }] },
      },
    })
  );
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  if (msg.setupComplete) {
    console.log('SETUP COMPLETE — session ready');
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Say hello in exactly one short sentence.' }] }],
          turnComplete: true,
        },
      })
    );
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
        console.log(
          `audio chunk: ${part.inlineData.mimeType} (~${Math.floor((part.inlineData.data.length * 0.75) / 1024)} KB) thought=${sc.thought ?? 'n/a'}`
        );
      }
      if (part.text) console.log(part.thought ? 'thought: ' : 'text part: ', part.text);
    }
  }
  if (sc.outputTranscription?.text) process.stdout.write('transcript: ' + sc.outputTranscription.text);
  if (sc.turnComplete) console.log('\nTURN COMPLETE');
});

ws.addEventListener('error', (e) => console.error('WS ERROR:', e.message || e));
ws.addEventListener('close', (e) => {
  console.log(`\nCLOSED code=${e.code} reason=${e.reason} totalAudioBytes=${audioBytes}`);
  process.exit(0);
});

setTimeout(() => process.exit(0), 90000);
