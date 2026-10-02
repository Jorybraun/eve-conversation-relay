import { isDeepStrictEqual } from "node:util";
import { defineChannel, POST, WS, type Channel, type WebSocketRouteHooks } from "eve/channels";
import { verifyTwilioRequest } from "eve/channels/twilio";
import { createConversationRelay } from "./relay.js";
import { buildConversationRelayTwiml } from "./twiml.js";
import type { RelayCall } from "./types.js";
import type { ConversationRelayChannelOptions, InboundCallRecord } from "./channel-types.js";

export type { ConversationRelayChannelOptions, InboundCallAuthorization, InboundCallRecord, InboundCallStore } from "./channel-types.js";

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const MAX_BODY_BYTES = 32_000;

function response(status: number): Response {
  return new Response(status === 503 ? "Phone service unavailable" : "Phone request rejected", {
    status, headers: { "Cache-Control": "no-store" },
  });
}

function rejectUpgrade(status: number): WebSocketRouteHooks {
  return { upgrade: () => response(status) };
}

function sameCall(a: RelayCall, b: RelayCall): boolean {
  return a.accountSid === b.accountSid && a.callSid === b.callSid && a.from === b.from && a.to === b.to;
}

function current(record: InboundCallRecord, now = Date.now()): boolean {
  return Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.expiresAt) &&
    record.createdAt <= now && record.expiresAt > now && record.expiresAt > record.createdAt;
}

function milliseconds(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive integer within the JavaScript timer range`);
  }
  return value;
}

/** Read a bounded form before passing it to Eve's public Twilio verifier. */
async function boundedRequest(request: Request): Promise<Request> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("phone_request_too_large");
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  return new Request(request.url, {
    method: request.method, headers: request.headers, body: Buffer.concat(chunks),
  });
}

/**
 * Inbound telephone channel. Export this value from agent/channels/phone.ts.
 * Uses public Eve routes and verification; owns no global store or dialing API.
 */
export function conversationRelayChannel(options: ConversationRelayChannelOptions): Channel {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("publicOrigin must be an HTTPS origin without path, credentials, query or fragment");
  }
  const route = options.route ?? "/phone";
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route)) {
    throw new TypeError("route must be an absolute path of nonempty simple segments without a trailing slash");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(options.accountSid) || !/^\+[1-9]\d{1,14}$/.test(options.phoneNumber) || !options.authToken.trim()) {
    throw new TypeError("A Twilio account SID, auth token and E.164 phone number are required");
  }
  const callTtlMs = milliseconds(options.callTtlMs ?? 600_000, "callTtlMs");
  if (options.maxDurationMs !== undefined) milliseconds(options.maxDurationMs, "maxDurationMs");
  const answerPath = `${route}/answer`;
  const streamPath = `${route}/stream`;
  const answerUrl = `${origin.origin}${answerPath}`;
  const streamOrigin = origin.origin.replace(/^https:/, "wss:");
  const streamUrl = (callSid: string) => `${streamOrigin}${streamPath}/${callSid}`;
  // Fail during channel configuration rather than after a caller has been accepted.
  buildConversationRelayTwiml({ ...options.speech, streamUrl: streamUrl(`CA${"0".repeat(32)}`) });

  async function stillAllowed(record: InboundCallRecord): Promise<boolean> {
    if (!current(record)) return false;
    const stored = await options.calls.get(record.call.callSid);
    if (!stored || !current(stored) || !sameCall(stored.call, record.call) ||
        stored.createdAt !== record.createdAt || stored.expiresAt !== record.expiresAt ||
        !isDeepStrictEqual(stored.auth, record.auth)) return false;
    const allowed = await options.authorize(record.call);
    return current(record) && allowed !== null && isDeepStrictEqual(allowed.auth, record.auth);
  }

  return defineChannel({
    audience: () => "private",
    turnPolicy: "queue",
    routes: [
      POST(answerPath, async request => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== answerPath || url.search ||
            request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
          return response(400);
        }
        let params: URLSearchParams;
        try {
          ({ params } = await verifyTwilioRequest(await boundedRequest(request), { authToken: options.authToken, webhookUrl: answerUrl }));
        } catch { return response(403); }
        const fields = ["AccountSid", "CallSid", "From", "To", "Direction"];
        if (fields.some(key => params.getAll(key).length !== 1) || params.get("Direction") !== "inbound") return response(400);
        const call: RelayCall = {
          accountSid: params.get("AccountSid")!, callSid: params.get("CallSid")!,
          from: params.get("From")!, to: params.get("To")!,
        };
        if (!CALL_SID.test(call.callSid) || !call.from.trim() || call.from.length > 128) return response(400);
        if (call.accountSid !== options.accountSid || call.to !== options.phoneNumber) return response(403);
        try {
          const allowed = await options.authorize(call);
          if (allowed === null) return response(403);
          const createdAt = Date.now();
          const record = await options.calls.putIfAbsent({
            call, auth: allowed.auth,
            ...(allowed.context === undefined ? {} : { context: [...allowed.context] }),
            createdAt, expiresAt: createdAt + callTtlMs,
          });
          if (!sameCall(record.call, call) || !isDeepStrictEqual(record.auth, allowed.auth)) return response(403);
          if (!current(record)) return response(410);
          return new Response(buildConversationRelayTwiml({ ...options.speech, streamUrl: streamUrl(call.callSid) }), {
            headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
          });
        } catch { return response(503); }
      }),
      WS(`${streamPath}/:callSid`, async (request, args) => {
        const callSid = args.params.callSid;
        const url = new URL(request.url);
        if (request.method !== "GET" || !CALL_SID.test(callSid ?? "") || url.pathname !== `${streamPath}/${callSid}` || url.search) return rejectUpgrade(400);
        try {
          // ConversationRelay signs the external WSS URL, even when the host sees HTTPS.
          await verifyTwilioRequest(request, { authToken: options.authToken, webhookUrl: streamUrl(callSid) });
        } catch { return rejectUpgrade(403); }
        try {
          const record = await options.calls.get(callSid);
          if (!record || record.call.callSid !== callSid || record.call.accountSid !== options.accountSid ||
              record.call.to !== options.phoneNumber || !await stillAllowed(record)) return rejectUpgrade(403);
          return createConversationRelay({
            call: record.call,
            session: {
              auth: record.auth, context: record.context,
              start: (message, delivery) => args.from(callSid).send(message, delivery),
            },
            authorize: () => stillAllowed(record),
            claim: () => options.calls.claimOnce(callSid),
            waitUntil: task => (options.waitUntil ?? args.waitUntil)(task),
            ...(options.onInterruption === undefined ? {} : { onInterruption: event => options.onInterruption!(record.call, event) }),
            ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: event => options.onDiagnostic!(record.call, event) }),
            ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
          });
        } catch { return rejectUpgrade(503); }
      }),
    ],
  });
}
