import assert from "node:assert/strict";
import test from "node:test";
import type { RouteHandlerArgs, Session, SessionSendOptions, WebSocketMessage, WebSocketPeer, WebSocketRouteHooks } from "eve/channels";
import { signTwilioRequest } from "eve/channels/twilio";
import { conversationRelayChannel, type ConversationRelayChannelOptions, type InboundCallAuthorization, type InboundCallRecord } from "../src/channel.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const authToken = "fictional-test-token";
const phoneNumber = "+15005550006";
const caller = "+15005550007";
const publicOrigin = "https://phone.example.test";
const answerUrl = `${publicOrigin}/phone/answer`;
const streamUrl = `wss://phone.example.test/phone/stream/${callSid}`;
const call = { accountSid, callSid, from: caller, to: phoneNumber };
const form = { AccountSid: accountSid, CallSid: callSid, From: caller, To: phoneNumber, Direction: "inbound" };

function signedAnswer(params = new URLSearchParams(form), signedUrl = answerUrl, requestUrl = answerUrl): Request {
  return new Request(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signTwilioRequest({ authToken, url: signedUrl, params }),
    },
    body: params,
  });
}

function signedUpgrade(signedUrl = streamUrl, requestUrl = streamUrl.replace(/^wss:/, "https:")): Request {
  return new Request(requestUrl, {
    headers: { "X-Twilio-Signature": signTwilioRequest({ authToken, url: signedUrl, params: new URLSearchParams() }) },
  });
}

function fixture(overrides: Partial<ConversationRelayChannelOptions> = {}) {
  const records = new Map<string, InboundCallRecord>();
  const claims = new Set<string>();
  const deliveries: { address: string; text: unknown; options: SessionSendOptions }[] = [];
  const lifetimes: Promise<unknown>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const closes: number[] = [];
  let authorization: InboundCallAuthorization | null = {
    auth: { authenticator: "fixture", principalType: "user", principalId: "fictional-user", attributes: {} },
    context: ["Help the fictional caller."],
  };
  let events!: ReadableStreamDefaultController<unknown>;
  const stream = new ReadableStream({ start(controller) { events = controller; } });
  const session = {
    id: "fixture-session",
    getEventStream: async () => stream,
    async send(text: unknown, options: SessionSendOptions) {
      deliveries.push({ address: "pinned-session", text, options });
      return { status: "accepted", sessionId: "fixture-session" };
    },
  } as unknown as Session;
  const args: RouteHandlerArgs = {
    params: { callSid },
    requestIp: null,
    waitUntil(task: Promise<unknown>) { lifetimes.push(task); },
    resolveSession: async () => undefined,
    attachSession() { throw new Error("Inbound channel must dispatch through a fresh call address"); },
    to() { throw new Error("Inbound channel must not dispatch to another channel"); },
    from: ((address: string) => ({
      async send(text: unknown, options: SessionSendOptions) {
        deliveries.push({ address, text, options });
        return session;
      },
    })) as unknown as RouteHandlerArgs["from"],
  };
  const peer = {
    send(data: unknown) { outbound.push(JSON.parse(String(data))); },
    close(code?: number) { closes.push(code ?? 1000); },
  } as unknown as WebSocketPeer;
  const options: ConversationRelayChannelOptions = {
    publicOrigin, accountSid, authToken, phoneNumber,
    speech: { stt: { provider: "Google", model: "telephony" }, tts: { provider: "Amazon", voice: "Joanna-Neural" } },
    calls: {
      async putIfAbsent(record) {
        if (!records.has(record.call.callSid)) records.set(record.call.callSid, structuredClone(record));
        return records.get(record.call.callSid)!;
      },
      async get(id) { return records.get(id) ?? null; },
      async claimOnce(id) {
        const record = records.get(id);
        if (!record || record.expiresAt <= Date.now() || claims.has(id)) return false;
        claims.add(id);
        return true;
      },
    },
    authorize: async () => authorization,
    ...overrides,
  };
  const channel = conversationRelayChannel(options);
  const answer = channel.routes.find(route => route.method === "POST");
  const websocket = channel.routes.find(route => route.transport === "websocket");
  assert.ok(answer && answer.transport !== "websocket");
  assert.ok(websocket?.transport === "websocket");
  let frame = 0;
  return {
    records, claims, deliveries, lifetimes, closes, outbound, options, args, peer, events,
    setAuthorization(value: InboundCallAuthorization | null) { authorization = value; },
    answer: (request = signedAnswer()) => answer.handler(request, args),
    upgrade: (request = signedUpgrade()) => websocket.handler(request, args),
    async receive(hooks: WebSocketRouteHooks, value: unknown) {
      await hooks.message?.(peer, { id: `frame-${++frame}`, text: () => JSON.stringify(value) } as WebSocketMessage);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    async close(hooks: WebSocketRouteHooks) {
      await hooks.close?.(peer, {});
      await Promise.all(lifetimes);
    },
  };
}

async function rejectionStatus(hooks: WebSocketRouteHooks): Promise<number | undefined> {
  const result = await hooks.upgrade?.(signedUpgrade());
  return result instanceof Response ? result.status : undefined;
}

test("channel_signed_inbound_call_streams_with_stored_auth_context_and_fresh_eve_address", async () => {
  const f = fixture();
  const answer = await f.answer();
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type")!, /^text\/xml/);
  const xml = await answer.text();
  assert.ok(xml.includes(`url="${streamUrl}"`));
  assert.match(xml, /transcriptionProvider="Google"/);
  assert.match(xml, /ttsProvider="Amazon"/);
  const stored = f.records.get(callSid)!;
  assert.deepEqual(stored.call, call);
  assert.equal(stored.expiresAt - stored.createdAt, 600_000);
  const hooks = await f.upgrade();
  assert.equal(f.lifetimes.length, 1, "Eve route lifetime registered synchronously during factory");
  try {
    await hooks.open?.(f.peer);
    await f.receive(hooks, { type: "setup", ...call });
    await f.receive(hooks, { type: "prompt", voicePrompt: "Help me choose a book.", last: true });
    assert.equal(f.deliveries[0].address, callSid);
    assert.deepEqual(f.deliveries[0].options, { auth: stored.auth, context: stored.context, turnPolicy: "queue" });
    f.events.enqueue({ type: "message.received", meta: { id: "e1" }, data: { turnId: "turn1", message: "Help me choose a book." } });
    f.events.enqueue({ type: "message.completed", meta: { id: "e2" }, data: { turnId: "turn1", stepIndex: 0, message: "What do you enjoy reading?" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.outbound, [{ type: "text", token: "What do you enjoy reading?", last: true, interruptible: true }]);
    await f.receive(hooks, { type: "prompt", voicePrompt: "Mysteries.", last: true });
    assert.equal(f.deliveries[1].address, "pinned-session");
  } finally { await f.close(hooks); }
});

test("channel_rejects_unsigned_tampered_and_wrong_origin_http_requests", async () => {
  const f = fixture();
  const missing = signedAnswer();
  missing.headers.delete("x-twilio-signature");
  assert.equal((await f.answer(missing)).status, 403);
  assert.equal((await f.answer(signedAnswer(new URLSearchParams(form), "https://attacker.example/phone/answer"))).status, 403);
  const changed = signedAnswer();
  const tampered = new Request(changed.url, { method: "POST", headers: changed.headers, body: new URLSearchParams({ ...form, From: "+15005550008" }) });
  assert.equal((await f.answer(tampered)).status, 403);
  assert.equal(f.records.size, 0);
});

test("channel_uses_configured_public_url_behind_proxy_and_ignores_forwarded_host", async () => {
  const f = fixture();
  const request = signedAnswer(new URLSearchParams(form), answerUrl, "http://internal.example/phone/answer");
  request.headers.set("x-forwarded-host", "attacker.example");
  request.headers.set("x-forwarded-proto", "http");
  const answer = await f.answer(request);
  assert.equal(answer.status, 200);
  assert.ok((await answer.text()).includes(streamUrl));
  assert.equal((await f.answer(signedAnswer(new URLSearchParams(form), `${answerUrl}?x=1`, `${answerUrl}?x=1`))).status, 400);
});

test("channel_rejects_wrong_account_number_direction_and_duplicate_identity_fields", async () => {
  const f = fixture();
  for (const changed of [{ AccountSid: `AC${"9".repeat(32)}` }, { To: "+15005550009" }]) {
    assert.equal((await f.answer(signedAnswer(new URLSearchParams({ ...form, ...changed })))).status, 403);
  }
  assert.equal((await f.answer(signedAnswer(new URLSearchParams({ ...form, Direction: "outbound-api" })))).status, 400);
  const duplicate = new URLSearchParams(form);
  duplicate.append("From", caller);
  assert.equal((await f.answer(signedAnswer(duplicate))).status, 400);
  assert.equal(f.records.size, 0);
});

test("channel_requires_explicit_caller_authorization_and_allows_explicit_guest", async () => {
  const f = fixture();
  f.setAuthorization(null);
  assert.equal((await f.answer()).status, 403);
  assert.equal(f.records.size, 0);
  f.setAuthorization({ auth: null });
  assert.equal((await f.answer()).status, 200);
  assert.equal(f.records.get(callSid)!.auth, null);
});

test("channel_duplicate_webhooks_preserve_original_auth_context_and_expiry", async () => {
  const f = fixture();
  const first = await (await f.answer()).text();
  const original = structuredClone(f.records.get(callSid)!);
  f.setAuthorization({ auth: original.auth, context: ["A later answer must not overwrite this call."] });
  const replies = await Promise.all([f.answer(), f.answer()]);
  assert.deepEqual(await Promise.all(replies.map(reply => reply.text())), [first, first]);
  assert.deepEqual(f.records.get(callSid), original);
  f.setAuthorization({ auth: null });
  assert.equal((await f.answer()).status, 403);
});

test("channel_expired_records_remain_replay_tombstones_and_cannot_upgrade", async () => {
  const f = fixture();
  await f.answer();
  const original = f.records.get(callSid)!;
  f.records.set(callSid, { ...original, createdAt: Date.now() - 2000, expiresAt: Date.now() - 1000 });
  assert.equal((await f.answer()).status, 410);
  assert.equal(await rejectionStatus(await f.upgrade()), 403);
  assert.ok(f.records.get(callSid)!.expiresAt < Date.now());
  assert.equal(f.lifetimes.length, 0);
});

test("channel_websocket_requires_wss_signature_and_a_previously_accepted_call", async () => {
  const f = fixture();
  assert.equal(await rejectionStatus(await f.upgrade()), 403);
  await f.answer();
  assert.equal(await rejectionStatus(await f.upgrade(signedUpgrade(streamUrl.replace(/^wss:/, "https:")))), 403);
  assert.equal(await rejectionStatus(await f.upgrade(signedUpgrade("wss://attacker.example/phone/stream/" + callSid))), 403);
  const missing = signedUpgrade();
  missing.headers.delete("x-twilio-signature");
  assert.equal(await rejectionStatus(await f.upgrade(missing)), 403);
  assert.equal(f.lifetimes.length, 0);
});

test("channel_connection_claim_rejects_parallel_websocket_replay", async () => {
  const f = fixture();
  await f.answer();
  const first = await f.upgrade();
  const second = await f.upgrade();
  try {
    await first.open?.(f.peer);
    await second.open?.(f.peer);
    await Promise.all([f.receive(first, { type: "setup", ...call }), f.receive(second, { type: "setup", ...call })]);
    assert.deepEqual(f.closes, [1011]);
    assert.equal(f.claims.size, 1);
  } finally {
    await first.close?.(f.peer, {});
    await f.close(second);
  }
});

test("channel_rechecks_permission_and_auth_before_dispatching_each_turn", async () => {
  for (const authorization of [null, { auth: null }]) {
    const f = fixture();
    await f.answer();
    const hooks = await f.upgrade();
    try {
      await hooks.open?.(f.peer);
      await f.receive(hooks, { type: "setup", ...call });
      f.setAuthorization(authorization);
      await f.receive(hooks, { type: "prompt", voicePrompt: "This must not dispatch.", last: true });
      assert.deepEqual(f.closes, [1011]);
      assert.equal(f.deliveries.length, 0);
    } finally { await f.close(hooks); }
  }
});

test("channel_checks_setup_against_accepted_call_and_uses_host_lifetime_override", async () => {
  const registered: Promise<void>[] = [];
  const f = fixture({ waitUntil: task => { registered.push(task); } });
  await f.answer();
  const hooks = await f.upgrade();
  try {
    assert.equal(registered.length, 1);
    assert.equal(f.lifetimes.length, 0);
    await hooks.open?.(f.peer);
    await f.receive(hooks, { type: "setup", ...call, from: "+15005550009" });
    assert.deepEqual(f.closes, [1011]);
    assert.equal(f.claims.size, 0);
  } finally { await f.close(hooks); await Promise.all(registered); }
});

test("channel_bounds_form_input_and_keeps_service_errors_private", async () => {
  const f = fixture({ authorize: async () => { throw new Error("do-not-leak-secret"); } });
  const failed = await f.answer();
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes("do-not-leak-secret"), false);
  const oversized = new URLSearchParams({ ...form, Extra: "x".repeat(32_001) });
  assert.equal((await fixture().answer(signedAnswer(oversized))).status, 403);
});

test("channel_rejects_invalid_public_configuration_before_accepting_calls", () => {
  for (const publicOrigin of ["http://phone.example.test", "https://user:secret@phone.example.test", "https://phone.example.test/path", "https://phone.example.test?x=1"]) {
    assert.throws(() => fixture({ publicOrigin }), TypeError);
  }
  for (const route of ["phone", "/phone/", "/phone/../other", "/phone?x=1"]) assert.throws(() => fixture({ route }), TypeError);
  assert.throws(() => fixture({ authToken: "" }), TypeError);
  assert.throws(() => fixture({ callTtlMs: 0 }), TypeError);
  assert.throws(() => fixture({ maxDurationMs: NaN }), TypeError);
});
