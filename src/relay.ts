import type { Session, WebSocketPeer, WebSocketRouteHooks } from "eve/channels";
import type { ConversationRelayOptions, RelayDeliveryOptions, RelayDiagnostic } from "./types.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Create hooks once per signature-verified WebSocket upgrade. Only transport
 * output is canceled on barge-in; the durable Eve turn continues to completion.
 */
export function createConversationRelay(deps: ConversationRelayOptions): WebSocketRouteHooks {
  const maxDurationMs = deps.maxDurationMs ?? 270_000;
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 2_147_483_647) {
    throw new TypeError("maxDurationMs must be a positive integer within the JavaScript timer range");
  }
  const delivery: RelayDeliveryOptions = Object.freeze({
    auth: deps.session.auth,
    ...(deps.session.context === undefined ? {} : { context: Object.freeze([...deps.session.context]) }),
    turnPolicy: "queue",
  });
  let ready = false;
  let closed = false;
  let generation = 0;
  let turnNumber = 0;
  let activeTurn: { id: string; generation: number; replyStarted: boolean } | null = null;
  let session: Session | undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let peerForTimeout: WebSocketPeer | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let finishLifetime!: () => void;
  const lifetime = new Promise<void>(resolve => { finishLifetime = resolve; });
  const tasks = new Set<Promise<unknown>>();
  // Register while the upgrade request context exists. Eve's route waitUntil
  // collects only tasks registered before its WebSocket factory returns.
  deps.waitUntil(lifetime);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setupTimer = setTimeout(() => {
    if (peerForTimeout) fail(peerForTimeout);
    else stop();
  }, 10_000);
  setupTimer.unref?.();
  let work: Promise<void> = Promise.resolve();
  const pending: { message: string; generation: number }[] = [];
  const seen = new Set<string>();
  const seenFrames = new Set<string>();
  const deltas = new Map<string, string>();

  function diagnostic(event: Omit<RelayDiagnostic, "at">) {
    try { deps.onDiagnostic?.({ ...event, at: new Date().toISOString() }); } catch { /* Diagnostics cannot stop a call. */ }
  }
  function finishWhenIdle() {
    if (!closed || tasks.size > 0) return;
    clearTimeout(cleanupTimer);
    finishLifetime();
  }
  function track(task: Promise<unknown>) {
    tasks.add(task);
    const settled = () => { tasks.delete(task); finishWhenIdle(); };
    void task.then(settled, settled);
  }
  function stop() {
    if (closed) return;
    closed = true;
    generation++;
    clearTimeout(timer);
    clearTimeout(setupTimer);
    // Do not cancel the Eve turn or its memory capture when the phone hangs up.
    // Give accepted dispatches and stream cleanup time to settle, without
    // keeping a failed/unopened connection alive indefinitely.
    cleanupTimer = setTimeout(finishLifetime, 10_000);
    cleanupTimer.unref?.();
    if (reader) track(reader.cancel().catch(() => undefined));
    finishWhenIdle();
  }
  function fail(peer: WebSocketPeer) {
    if (!closed) diagnostic({ phase: "relay_error" });
    stop();
    try { peer.close(1011, "Phone conversation unavailable"); }
    catch { /* A lost socket must not prevent cleanup or crash the host. */ }
  }
  function queue(peer: WebSocketPeer, task: () => Promise<void>) {
    work = work.then(task).catch(() => fail(peer));
    track(work);
    return work;
  }
  function text(peer: WebSocketPeer, token: string, last: boolean) {
    peer.send(JSON.stringify({ type: "text", token, last, interruptible: true }));
  }
  function receivedGeneration(message: unknown): number {
    if (typeof message !== "string") throw new Error("phone_input_mismatch");
    // Eve may fold adjacent queued deliveries into one message.received. It
    // preserves their exact text, joined by two newlines. Consume the matching
    // ordered prefix so the resulting reply belongs to its newest speech input.
    let combined = "";
    for (let index = 0; index < pending.length; index++) {
      combined += `${index === 0 ? "" : "\n\n"}${pending[index].message}`;
      if (combined === message) {
        const matchedGeneration = pending[index].generation;
        pending.splice(0, index + 1);
        return matchedGeneration;
      }
      if (!message.startsWith(combined)) break;
    }
    throw new Error("phone_input_mismatch");
  }
  async function pump(peer: WebSocketPeer, stream: ReadableStream<unknown>) {
    if (closed) { await stream.cancel(); return; }
    reader = stream.getReader();
    diagnostic({ phase: "stream_attached" });
    try {
      while (!closed) {
        const next = await reader.read();
        if (next.done) break;
        const event = object(next.value);
        const data = object(event?.data);
        if (!event || !data) continue;
        const metadata = object(event.meta);
        const emittedAt = typeof metadata?.at === "string" ? Date.parse(metadata.at) : NaN;
        const receivedAt = Date.now();
        const lagMs = Number.isFinite(emittedAt) && emittedAt <= receivedAt ? receivedAt - emittedAt : undefined;
        const id = metadata?.id;
        if (typeof id === "string") {
          if (seen.has(id)) continue;
          if (seen.size >= 20_000) throw new Error("phone_event_limit");
          seen.add(id);
        }
        if (event.type === "message.received" && typeof data.turnId === "string" && data.kind !== "execution.background_task") {
          activeTurn = { id: data.turnId, generation: receivedGeneration(data.message), replyStarted: false };
          diagnostic({ phase: "turn_received", turnId: activeTurn.id, count: pending.length, lagMs });
        }
        if (event.type === "turn.failed" || event.type === "session.failed") throw new Error("phone_turn_failed");
        if (!activeTurn || data.turnId !== activeTurn.id || activeTurn.generation !== generation || closed) continue;
        const key = `${data.turnId}:${data.stepIndex}`;
        if (event.type === "message.appended" && typeof data.messageDelta === "string") {
          const delivered = (deltas.get(key) ?? "") + data.messageDelta;
          if (delivered.length > 16_000) throw new Error("phone_response_limit");
          deltas.set(key, delivered);
          text(peer, data.messageDelta, false);
          if (!activeTurn.replyStarted && data.messageDelta.length > 0) {
            activeTurn.replyStarted = true;
            diagnostic({ phase: "reply_started", turnId: activeTurn.id, lagMs });
          }
        } else if (event.type === "message.completed") {
          const complete = typeof data.message === "string" ? data.message : "";
          if (complete.length > 16_000) throw new Error("phone_response_limit");
          const sent = deltas.get(key) ?? "";
          // Some Eve providers only emit the completed message. Never replay
          // already-streamed text or turn tool/reasoning events into speech.
          if (!complete.startsWith(sent)) throw new Error("phone_response_mismatch");
          text(peer, complete.slice(sent.length), true);
          if (!activeTurn.replyStarted && complete.length > sent.length) {
            activeTurn.replyStarted = true;
            diagnostic({ phase: "reply_started", turnId: activeTurn.id, lagMs });
          }
          diagnostic({ phase: "reply_completed", turnId: activeTurn.id, count: complete.length, lagMs });
          deltas.delete(key);
        }
      }
      if (!closed) fail(peer);
    } finally { reader.releaseLock(); }
  }

  return {
    open(peer) {
      if (closed) { peer.close(1000, "Phone setup timed out"); return; }
      peerForTimeout = peer;
      // The host and call provider must allow setup/cleanup beyond this duration.
      timer = setTimeout(() => {
        try { if (!closed) peerForTimeout?.send(JSON.stringify({ type: "end" })); }
        catch { diagnostic({ phase: "relay_error" }); }
        finally { stop(); }
      }, maxDurationMs);
      timer.unref?.();
    },
    message(peer, message) {
      if (closed) return;
      let event: Record<string, unknown> | null;
      try {
        const raw = message.text();
        if (raw.length > 32_000) throw new Error("phone_frame_limit");
        event = object(JSON.parse(raw));
        if (!event || typeof event.type !== "string") throw new Error("invalid_phone_event");
      } catch { fail(peer); return; }
      if (seenFrames.has(message.id)) return;
      if (seenFrames.size >= 4_000) { fail(peer); return; }
      seenFrames.add(message.id);
      if (event.type === "setup") {
        const setup = event;
        return queue(peer, async () => {
          if (closed) return;
          if (ready) {
            if (setup.callSid !== deps.call.callSid) fail(peer);
            return;
          }
          if (setup.accountSid !== deps.call.accountSid || setup.callSid !== deps.call.callSid ||
              setup.from !== deps.call.from || setup.to !== deps.call.to ||
              !await deps.authorize() || !await deps.claim()) {
            fail(peer); return;
          }
          if (closed) return;
          clearTimeout(setupTimer);
          ready = true;
        });
      }
      if (event.type === "interrupt") {
        // Synchronous suppression also covers output already in flight while a
        // provider/memory operation is awaited. Twilio stops its own playback.
        const interruptionGeneration = ++generation;
        const interruptedTurn = activeTurn?.id ?? null;
        const heard = typeof event.utteranceUntilInterrupt === "string" ? event.utteranceUntilInterrupt.slice(0,16_000) : "";
        return queue(peer, async () => {
          if (!ready || closed || !await deps.authorize()) { fail(peer); return; }
          const duration = event.durationUntilInterruptMs;
          await deps.onInterruption?.({
            id: `interrupt:${interruptedTurn ?? "greeting"}:${interruptionGeneration}`,
            turnId: interruptedTurn,
            heardText: heard,
            ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
          });
        });
      }
      if (event.type === "error") { fail(peer); return; }
      if (event.type !== "prompt") return;
      if (typeof event.last !== "boolean" || typeof event.voicePrompt !== "string" || event.voicePrompt.length > 8_000) { fail(peer); return; }
      // With partialPrompts off, last=true is the completed STT utterance;
      // partial hypotheses must never become additional finalized utterances.
      if (!event.last || !event.voicePrompt.trim()) return;
      const prompt = event.voicePrompt;
      diagnostic({ phase: "prompt_received", count: prompt.length });
      const nextGeneration = ++generation;
      return queue(peer, async () => {
        if (closed) return;
        if (!ready || ++turnNumber > 120 || !await deps.authorize()) { fail(peer); return; }
        pending.push({ message: prompt, generation: nextGeneration });
        if (session) {
          const result = await session.send(prompt, delivery);
          if (result.status === "session_not_active") throw new Error("phone_session_not_active");
          diagnostic({ phase: "session_dispatched", count: turnNumber });
        } else {
          session = await deps.session.start(prompt, delivery);
          diagnostic({ phase: "session_dispatched", count: turnNumber });
          if (!closed) track(pump(peer, await session.getEventStream()).catch(() => fail(peer)));
        }
      });
    },
    close() { stop(); },
    error() { stop(); },
  };
}
