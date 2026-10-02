import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Session, WebSocketMessage, WebSocketPeer } from "eve/channels";

import {
  createConversationRelay,
  type ConversationRelayOptions,
  type RelayDeliveryOptions,
  type RelayDiagnostic,
  type RelayInterruption,
} from "../src/index.js";

const CALL = {
  accountSid: "ACfictional",
  callSid: "CAfictional",
  from: "+15005550006",
  to: "+15005550007",
} as const;
const AUTH = {
  authenticator: "library-member-session",
  principalType: "user" as const,
  principalId: "fictional_library_member",
  attributes: { branch: "fictional_north_branch" },
};
const CONTEXT = ["Help this library member find a book."] as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

interface Frame { type: string; token?: string; last?: boolean }
type FixtureOptions = {
  open?: boolean;
  authorize?: () => Promise<boolean>;
  claim?: () => Promise<boolean>;
  start?: () => Promise<void>;
  send?: () => Promise<void>;
  sendResult?: { status: "session_not_active" };
  peerSend?: (frame: Frame) => void;
  onInterruption?: ConversationRelayOptions["onInterruption"];
  onDiagnostic?: ConversationRelayOptions["onDiagnostic"];
  maxDurationMs?: number;
};

function fixture(t: TestContext, options: FixtureOptions = {}) {
  const output: Frame[] = [];
  const starts: { message: string; options: RelayDeliveryOptions }[] = [];
  const sends: { message: string; options: RelayDeliveryOptions }[] = [];
  const interruptions: RelayInterruption[] = [];
  const diagnostics: RelayDiagnostic[] = [];
  const lifetimes: Promise<void>[] = [];
  let allowed = true;
  let claims = 0;
  let closed = false;
  let canceled = false;
  let readerCanceled = false;
  let frameNumber = 0;
  let eventNumber = 0;
  let controller!: ReadableStreamDefaultController<unknown>;
  const stream = new ReadableStream<unknown>({
    start(value) { controller = value; },
    cancel() { readerCanceled = true; },
  });
  // Only public Eve channel types are used. This is an isolated transport
  // fixture, with no app identity store, provider account, or network traffic.
  const session = {
    id: "fictional_per_call_session",
    getEventStream: async () => stream,
    async send(message: string, delivery: RelayDeliveryOptions) {
      sends.push({ message, options: delivery });
      await options.send?.();
      return options.sendResult ?? {};
    },
    async cancel() { canceled = true; },
  } as unknown as Session;
  const peer = {
    send(data: string) {
      const frame = JSON.parse(data) as Frame;
      options.peerSend?.(frame);
      output.push(frame);
    },
    close() { closed = true; },
  } as unknown as WebSocketPeer;
  const config: ConversationRelayOptions = {
    call: CALL,
    session: {
      auth: AUTH,
      context: CONTEXT,
      async start(message, delivery) {
        starts.push({ message, options: delivery });
        await options.start?.();
        return session;
      },
    },
    authorize: async () => allowed && (options.authorize ? await options.authorize() : true),
    async claim() {
      claims += 1;
      return options.claim ? options.claim() : claims === 1;
    },
    async onInterruption(event) {
      interruptions.push(event);
      await options.onInterruption?.(event);
    },
    waitUntil(task) { lifetimes.push(task); },
    onDiagnostic(event) {
      diagnostics.push(event);
      options.onDiagnostic?.(event);
    },
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
  };
  const hooks = createConversationRelay(config);
  if (options.open !== false) void hooks.open?.(peer);
  async function close() { await hooks.close?.(peer, {}); await settle(); }
  t.after(close);
  function frame(event: unknown, id = `frame_${++frameNumber}`) {
    return hooks.message?.(peer, { id, text: () => JSON.stringify(event) } as WebSocketMessage);
  }
  function event(type: string, data: Record<string, unknown>, id = `event_${++eventNumber}`) {
    controller.enqueue({ type, data, meta: { id } });
  }
  async function setup() { await frame({ type: "setup", ...CALL }); await settle(); }
  async function prompt(message: string) { await frame({ type: "prompt", voicePrompt: message, last: true }); await settle(); }
  function receive(turnId: string, message: string) { event("message.received", { turnId, message }); }
  return {
    output, starts, sends, interruptions, diagnostics, lifetimes, frame, event, setup, prompt, receive, close,
    error: () => hooks.error?.(peer, new Error("fictional_transport_error")),
    revoke() { allowed = false; },
    get closed() { return closed; },
    get canceled() { return canceled; },
    get readerCanceled() { return readerCanceled; },
    get claims() { return claims; },
  };
}

test("relay_runs_without_pipey_dependencies", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("I would like a book recommendation.");
  f.receive("turn_1", f.starts[0].message);
  f.event("message.appended", { turnId: "turn_1", stepIndex: 0, messageDelta: "What do " });
  f.event("message.completed", { turnId: "turn_1", stepIndex: 0, message: "What do you enjoy reading?" });
  await settle();
  assert.deepEqual(f.output.map(frame => [frame.token, frame.last]), [["What do ", false], ["you enjoy reading?", true]]);
  assert.equal(f.closed, false);
});

test("relay_preserves_app_identity_and_context", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("A mystery, please.");
  await f.prompt("Something set at sea.");
  assert.equal(f.starts.length, 1, "only the first utterance resolves a per-call session");
  assert.equal(f.sends.length, 1, "subsequent utterances use the returned fixed session");
  for (const delivery of [...f.starts, ...f.sends]) {
    assert.deepEqual(delivery.options, { auth: AUTH, context: CONTEXT, turnPolicy: "queue" });
  }
  assert.equal(f.starts[0].message, "A mystery, please.");
  assert.equal(f.sends[0].message, "Something set at sea.");
});

test("relay_streams_only_current_assistant_text", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("Find a book.");
  f.receive("turn_1", "Find a book.");
  f.event("tool.started", { turnId: "turn_1", text: "private tool input" });
  f.event("reasoning.appended", { turnId: "turn_1", messageDelta: "private reasoning" });
  f.event("message.appended", { turnId: "foreign_turn", stepIndex: 0, messageDelta: "foreign reply" });
  f.event("message.appended", { turnId: "turn_1", stepIndex: 0, messageDelta: "Try " });
  f.event("message.completed", { turnId: "turn_1", stepIndex: 0, message: "Try a nautical mystery." });
  await settle();
  assert.equal(f.output.map(frame => frame.token ?? "").join(""), "Try a nautical mystery.");
});

test("relay_interrupt_does_not_cancel_durable_session", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("A mystery.");
  f.receive("turn_1", "A mystery.");
  f.event("message.appended", { turnId: "turn_1", stepIndex: 0, messageDelta: "You might " });
  await settle();
  const interrupted = f.frame({ type: "interrupt", utteranceUntilInterrupt: "You", durationUntilInterruptMs: 180 });
  f.event("message.appended", { turnId: "turn_1", stepIndex: 0, messageDelta: "hear stale output" });
  await interrupted;
  await f.prompt("Actually, science fiction.");
  f.receive("turn_2", "Actually, science fiction.");
  f.event("message.completed", { turnId: "turn_2", stepIndex: 0, message: "What science fiction do you like?" });
  await settle();
  assert.deepEqual(f.output.map(frame => frame.token), ["You might ", "What science fiction do you like?"]);
  assert.equal(f.interruptions[0].turnId, "turn_1");
  assert.equal(f.interruptions[0].heardText, "You");
  assert.equal(f.interruptions[0].durationMs, 180);
  assert.ok(f.interruptions[0].id);
  assert.equal(f.canceled, false);
});

test("relay_greeting_interruption_has_no_invented_turn", async t => {
  const f = fixture(t);
  await f.setup();
  await f.frame({ type: "interrupt", utteranceUntilInterrupt: "Welcome", durationUntilInterruptMs: 100 });
  assert.equal(f.interruptions.length, 1);
  assert.equal(f.interruptions[0].turnId, null);
  assert.equal(f.interruptions[0].heardText, "Welcome");
  assert.equal(f.interruptions[0].durationMs, 100);
  assert.equal(f.starts.length, 0);
});

test("relay_closes_when_interruption_persistence_rejects", async t => {
  const f = fixture(t, { onInterruption: async () => { throw new Error("fictional_storage_failure"); } });
  await f.setup();
  await f.frame({ type: "interrupt", utteranceUntilInterrupt: "Welcome" });
  await settle();
  assert.equal(f.closed, true);
  assert.equal(f.canceled, false);
  await f.lifetimes[0];
});

test("relay_closes_when_initial_or_followup_dispatch_rejects", async t => {
  const first = fixture(t, { start: async () => { throw new Error("fictional_dispatch_failure"); } });
  await first.setup();
  await first.prompt("First input.");
  assert.equal(first.closed, true);
  const followup = fixture(t, { send: async () => { throw new Error("fictional_dispatch_failure"); } });
  await followup.setup();
  await followup.prompt("First input.");
  await followup.prompt("Followup input.");
  assert.equal(followup.closed, true);
  assert.equal(followup.canceled, false);
});

test("relay_closes_when_followup_session_is_no_longer_active", async t => {
  const f = fixture(t, { sendResult: { status: "session_not_active" } });
  await f.setup();
  await f.prompt("First input.");
  assert.equal(f.diagnostics.filter(event => event.phase === "session_dispatched").length, 1);
  await f.prompt("Input after the session ended.");
  assert.equal(f.closed, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.diagnostics.filter(event => event.phase === "session_dispatched").length, 1,
    "an inactive session must not be reported as a successful followup dispatch");
  assert.equal(f.diagnostics.at(-1)?.phase, "relay_error");
  assert.equal(f.canceled, false);
  await f.lifetimes[0];
});

test("relay_rechecks_access_and_refuses_duplicate_connection_claims", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("An allowed input.");
  f.revoke();
  await f.prompt("A revoked input.");
  assert.equal(f.closed, true);
  assert.equal(f.sends.length, 0);
  const denied = fixture(t, { claim: async () => false });
  await denied.setup();
  assert.equal(denied.closed, true);
  await denied.prompt("Must not dispatch.");
  assert.equal(denied.starts.length, 0);
});

test("relay_rejects_foreign_setup_and_ignores_partial_prompts", async t => {
  const foreign = fixture(t);
  await foreign.frame({ type: "setup", ...CALL, accountSid: "ACanother_account" });
  await settle();
  assert.equal(foreign.closed, true);
  assert.equal(foreign.claims, 0);
  const f = fixture(t);
  await f.setup();
  await f.frame({ type: "prompt", voicePrompt: "An interim hypothesis", last: false });
  await f.frame({ type: "prompt", voicePrompt: " ", last: true });
  assert.equal(f.starts.length, 0);
});

test("relay_deduplicates_frame_and_eve_event_ids_without_dropping_repeated_speech", async t => {
  const f = fixture(t);
  await f.setup();
  const prompt = { type: "prompt", voicePrompt: "Hello", last: true };
  await f.frame(prompt, "same_frame");
  await f.frame(prompt, "same_frame");
  f.receive("turn_1", "Hello");
  f.event("message.completed", { turnId: "turn_1", stepIndex: 0, message: "Hello there." }, "same_event");
  f.event("message.completed", { turnId: "turn_1", stepIndex: 0, message: "Hello there." }, "same_event");
  await settle();
  assert.equal(f.starts.length, 1);
  assert.equal(f.output.length, 1);
  await f.frame(prompt, "new_frame");
  assert.equal(f.sends.length, 1, "identical words in a new frame remain a separate utterance");
});

test("relay_fails_closed_on_unrelated_replayed_session_input", async t => {
  const f = fixture(t);
  await f.setup();
  await f.prompt("Current call input.");
  f.receive("historical_turn", "An older session input.");
  f.event("message.completed", { turnId: "historical_turn", stepIndex: 0, message: "Old private history." });
  await settle();
  assert.equal(f.closed, true);
  assert.equal(f.output.length, 0);
});

test("relay_registers_lifetime_at_construction_and_cleans_reader_on_disconnect", async t => {
  const f = fixture(t);
  assert.equal(f.lifetimes.length, 1);
  await f.setup();
  await f.prompt("An accepted input.");
  await f.close();
  await f.lifetimes[0];
  assert.equal(f.readerCanceled, true);
  assert.equal(f.canceled, false);
  await f.prompt("After disconnect.");
  assert.equal(f.sends.length, 0);
});

test("relay_disconnect_keeps_inflight_durable_dispatch_alive", async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { start: () => blocked });
  await f.setup();
  const dispatched = f.frame({ type: "prompt", voicePrompt: "Keep this input.", last: true });
  await settle();
  let finished = false;
  void f.lifetimes[0].then(() => { finished = true; });
  await f.close();
  assert.equal(finished, false);
  release();
  await dispatched;
  await f.lifetimes[0];
  assert.equal(f.canceled, false);
  assert.equal(f.starts.length, 1);
});

test("relay_duration_limit_ends_transport_and_preserves_session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { maxDurationMs: 1250 });
  await f.setup();
  await f.prompt("An input.");
  t.mock.timers.tick(1250);
  await f.lifetimes[0];
  assert.equal(f.output.at(-1)?.type, "end");
  assert.equal(f.readerCanceled, true);
  assert.equal(f.canceled, false);
});

test("relay_opened_socket_without_setup_closes_after_ten_seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { maxDurationMs: 60_000 });
  t.mock.timers.tick(9_999);
  assert.equal(f.closed, false);
  t.mock.timers.tick(1);
  await f.lifetimes[0];
  assert.equal(f.closed, true);
  assert.equal(f.starts.length, 0);
  assert.equal(f.output.length, 0, "setup expiry occurs before the normal end-of-call timer");
});

test("relay_late_setup_authorization_or_claim_cannot_revive_expired_connection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["authorize", "claim"] as const) {
    let release!: (value: boolean) => void;
    let entered = false;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const f = fixture(t, {
      maxDurationMs: 60_000,
      [stage]: async () => { entered = true; return gate; },
    });
    const setup = f.frame({ type: "setup", ...CALL });
    await settle();
    assert.equal(entered, true, `setup must be blocked in ${stage}`);
    const queued = f.frame({ type: "prompt", voicePrompt: "Queued before expiry.", last: true });
    t.mock.timers.tick(10_000);
    assert.equal(f.closed, true);
    release(true);
    await setup;
    await queued;
    await f.lifetimes[0];
    await f.prompt("After late setup completed.");
    assert.equal(f.starts.length, 0, `late ${stage} success must never dispatch queued or later speech`);
    assert.equal(f.sends.length, 0);
    assert.equal(f.diagnostics.some(event => event.phase === "session_dispatched"), false);
  }
});

test("relay_timeout_cleans_up_when_sending_end_frame_throws", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attemptedEnd = false;
  const f = fixture(t, {
    maxDurationMs: 1250,
    peerSend(frame) {
      if (frame.type === "end") {
        attemptedEnd = true;
        throw new Error("fictional_closed_socket");
      }
    },
  });
  await f.setup();
  await f.prompt("Keep the durable input.");
  assert.doesNotThrow(() => t.mock.timers.tick(1250));
  await f.lifetimes[0];
  assert.equal(attemptedEnd, true);
  assert.equal(f.readerCanceled, true);
  assert.equal(f.canceled, false);
  assert.equal(f.diagnostics.at(-1)?.phase, "relay_error");
  await f.prompt("After timeout.");
  assert.equal(f.sends.length, 0);
});

test("relay_unopened_connection_expires_and_transport_errors_cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const unopened = fixture(t, { open: false });
  t.mock.timers.tick(10_000);
  await unopened.lifetimes[0];
  assert.equal(unopened.starts.length, 0);
  const f = fixture(t);
  await f.setup();
  await f.prompt("An input.");
  await f.error();
  await f.lifetimes[0];
  assert.equal(f.readerCanceled, true);
  assert.equal(f.canceled, false);
});

test("relay_rejects_invalid_duration_configuration", t => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2 ** 31]) {
    assert.throws(() => fixture(t, { maxDurationMs: value }), /duration|positive|integer/i);
  }
});

test("relay_diagnostics_never_include_content_and_cannot_break_speech", async t => {
  const f = fixture(t, { onDiagnostic: () => { throw new Error("fictional_observer_failure"); } });
  await f.setup();
  await f.prompt("Private library request.");
  f.receive("turn_1", "Private library request.");
  f.event("message.completed", { turnId: "turn_1", stepIndex: 0, message: "Private recommendation." });
  await settle();
  assert.equal(f.closed, false);
  assert.equal(f.output[0].token, "Private recommendation.");
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /Private|fictional_library_member|ACfictional|CAfictional|1500555000/);
  assert.ok(f.diagnostics.every(event => Number.isFinite(Date.parse(event.at))));
});
