/** Offline walkthrough: simulated speech and Eve events, no model or phone call. */
import assert from "node:assert/strict";
import type { Session, WebSocketMessage, WebSocketPeer } from "eve/channels";
import { buildConversationRelayTwiml, createConversationRelay } from "@pipey/eve-conversation-relay";

const call = { accountSid: "ACdemo", callSid: "CAdemo", from: "+15005550006", to: "+15005550007" };
let events!: ReadableStreamDefaultController<unknown>;
const stream = new ReadableStream({ start(controller) { events = controller; } });
let lifetime: Promise<void> | undefined;
const sent: { type: string; token?: string; last?: boolean }[] = [];
let interrupted = false;
const session = {
  id: "library_demo_session",
  getEventStream: async () => stream,
  async send() { return { status: "accepted", sessionId: "library_demo_session" }; },
} as unknown as Session;
const hooks = createConversationRelay({
  call,
  session: {
    auth: { authenticator: "library", principalType: "user", principalId: "fictional_reader", attributes: {} },
    context: ["Help the reader choose a book."],
    async start(text, options) {
      assert.equal(options.turnPolicy, "queue");
      console.log("2. The package sends finalized speech to the app's Eve session:", text);
      return session;
    },
  },
  // Fixture values only: a real host must verify the upgrade and durable claim.
  authorize: async () => true,
  claim: async () => true,
  onInterruption(event) { interrupted = true; console.log("4. App receives provider-reported heard prefix:", event.heardText); },
  waitUntil(task) { lifetime = task; },
});
const peer = {
  send(data: string) { sent.push(JSON.parse(data)); },
  close() { throw new Error("Unexpected synthetic transport failure"); },
} as unknown as WebSocketPeer;
let frame = 0;
async function receive(value: unknown) {
  await hooks.message?.(peer, { id: `frame_${++frame}`, text: () => JSON.stringify(value) } as WebSocketMessage);
  await new Promise<void>(resolve => setImmediate(resolve));
}
let event = 0;
function emit(type: string, data: Record<string, unknown>) {
  events.enqueue({ type, data, meta: { id: `event_${++event}` } });
}

console.log("OFFLINE SIMULATION: speech providers and Eve generation are fixtures.");
const xml = buildConversationRelayTwiml({
  streamUrl: "wss://library.example.test/voice",
  stt: { provider: "Google", model: "telephony" },
  tts: { provider: "Amazon", voice: "Joanna-Neural" },
  greeting: "Welcome to the library.",
});
assert.match(xml, /transcriptionProvider="Google"/);
assert.match(xml, /ttsProvider="Amazon"/);
console.log("1. The host configures Google STT + Amazon TTS in TwiML.");
try {
  await hooks.open?.(peer);
  await receive({ type: "setup", ...call });
  await receive({ type: "prompt", voicePrompt: "I would like a mystery novel.", last: true });
  emit("message.received", { turnId: "turn_1", message: "I would like a mystery novel." });
  emit("message.appended", { turnId: "turn_1", stepIndex: 0, messageDelta: "What kind " });
  emit("message.completed", { turnId: "turn_1", stepIndex: 0, message: "What kind of mystery do you enjoy?" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sent.map(value => value.token ?? "").join(""), "What kind of mystery do you enjoy?");
  console.log("3. The package streams reply text; Twilio would synthesize it:", sent.map(value => value.token ?? "").join(""));
  await receive({ type: "interrupt", utteranceUntilInterrupt: "What kind", durationUntilInterruptMs: 400 });
  assert.equal(interrupted, true);
} finally {
  await hooks.close?.(peer, {});
  await lifetime;
}
console.log("5. Transport closed; durable Eve work was not cancelled. Simulation passed.");
