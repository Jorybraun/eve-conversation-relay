import { defineChannel, WS, type SessionSendOptions } from "eve/channels";
import { createConversationRelay, type RelayCall, type RelayInterruption } from "@pipey/eve-conversation-relay";

/** All methods belong to the helpdesk app. No PIPEY store or identity is used. */
export interface HelpdeskVoiceHost {
  /** Verify X-Twilio-Signature using the PUBLIC WSS URL, then resolve this call. */
  verifyUpgrade(request: Request, callId: string): Promise<{
    call: RelayCall;
    auth: SessionSendOptions["auth"];
  } | null>;
  isAllowed(callSid: string): Promise<boolean>;
  claimOnce(callSid: string): Promise<boolean>;
  recordInterruption(callSid: string, event: RelayInterruption): Promise<void>;
  /** Use the host's lifetime API while its upgrade request context is active. */
  waitUntil(task: Promise<void>): void;
}

/** An independently typed consumer; deployment and dialing belong to its host. */
export function helpdeskVoiceChannel(host: HelpdeskVoiceHost) {
  return defineChannel({
    audience: () => "private",
    turnPolicy: "queue",
    routes: [WS("/helpdesk/voice/:callId", async (request, { params, from }) => {
      const verified = await host.verifyUpgrade(request, params.callId);
      if (!verified) return { upgrade: () => new Response(null, { status: 403 }) };
      const { call, auth } = verified;
      return createConversationRelay({
        call,
        session: {
          auth,
          context: ["Help the caller describe their support issue. Ask one question at a time."],
          // Fresh per-call address. Auth principal may share memory across channels.
          start: (message, options) => from(call.callSid).send(message, options),
        },
        authorize: () => host.isAllowed(call.callSid),
        claim: () => host.claimOnce(call.callSid),
        onInterruption: event => host.recordInterruption(call.callSid, event),
        waitUntil: task => host.waitUntil(task),
      });
    })],
  });
}
