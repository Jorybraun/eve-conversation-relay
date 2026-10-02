import type { SessionSendOptions } from "eve/channels";
import type { ConversationRelayTwimlOptions } from "./twiml.js";
import type { RelayCall, RelayDiagnostic, RelayInterruption } from "./types.js";

export interface InboundCallAuthorization {
  /** Explicit null grants an unauthenticated Eve session, not a verified identity. */
  readonly auth: SessionSendOptions["auth"];
  readonly context?: readonly string[];
}

/** App-owned durable data. Contains caller metadata and potentially sensitive auth. */
export interface InboundCallRecord extends InboundCallAuthorization {
  readonly call: RelayCall;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface InboundCallStore {
  /**
   * Atomically insert by callSid, or return the original unchanged record.
   * Never refresh expiry/auth on a duplicate. Retain expired records or replay
   * tombstones: Twilio signatures have no timestamp, so deletion permits replay.
   */
  putIfAbsent(record: InboundCallRecord): Promise<InboundCallRecord>;
  get(callSid: string): Promise<InboundCallRecord | null>;
  /** Atomic one-time claim; reject missing, expired or already claimed records. */
  claimOnce(callSid: string): Promise<boolean>;
}

export interface ConversationRelayChannelOptions {
  /** Fixed external HTTPS origin. Never derive it from untrusted forwarded headers. */
  readonly publicOrigin: string;
  /** Route prefix, default /phone. Produces POST /answer and WS /stream/:callSid. */
  readonly route?: string;
  readonly accountSid: string;
  readonly authToken: string;
  readonly phoneNumber: string;
  readonly speech: Omit<ConversationRelayTwimlOptions, "streamUrl">;
  readonly calls: InboundCallStore;
  /**
   * Explicitly accept or reject the caller. Rechecked at answer, upgrade, setup
   * and each turn. The returned auth must still match the initial stored auth;
   * context is pinned to the first accepted answer. Caller ID alone is not proof
   * of application identity. Return null to deny; { auth: null } allows a guest.
   */
  authorize(call: RelayCall): Promise<InboundCallAuthorization | null>;
  /** Optional host override. Defaults to Eve's route waitUntil. */
  readonly waitUntil?: (task: Promise<void>) => void;
  readonly onInterruption?: (call: RelayCall, event: RelayInterruption) => void | Promise<void>;
  readonly onDiagnostic?: (call: RelayCall, event: RelayDiagnostic) => void;
  /** Initial acceptance expires after this many milliseconds; default 600000. */
  readonly callTtlMs?: number;
  readonly maxDurationMs?: number;
}
