import type { Session, SessionSendOptions } from "eve/channels";

/** Verified expected values, resolved by the app before accepting an upgrade. */
export interface RelayCall {
  readonly accountSid: string;
  readonly callSid: string;
  readonly from: string;
  readonly to: string;
}

export interface RelayDiagnostic {
  readonly phase: "prompt_received" | "session_dispatched" | "stream_attached" |
    "turn_received" | "reply_started" | "reply_completed" | "relay_error";
  readonly at: string;
  readonly turnId?: string;
  readonly count?: number;
  readonly lagMs?: number;
}

/** Provider-reported playback prefix; not an independent delivery receipt. */
export interface RelayInterruption {
  /** Unique within this connection. Scope persistence by the call ID. */
  readonly id: string;
  /** Null when the preset greeting was interrupted. */
  readonly turnId: string | null;
  readonly heardText: string;
  readonly durationMs?: number;
}

export type RelayDeliveryOptions = Pick<SessionSendOptions, "auth" | "context"> & {
  readonly turnPolicy: "queue";
};

export interface ConversationRelayOptions {
  readonly call: RelayCall;
  readonly session: {
    readonly auth: SessionSendOptions["auth"];
    readonly context?: readonly string[];
    /**
     * Dispatch the first utterance to a NEW per-call Eve address, passing options
     * through unchanged. The relay pins subsequent turns to the returned session.
     * Existing session history/reconnection is not supported by this version.
     */
    start(message: string, options: RelayDeliveryOptions): Promise<Session>;
  };
  /** Recheck current app permission before setup and each finalized utterance. */
  authorize(): Promise<boolean>;
  /** Atomically claim the sole connection for this call in app-owned storage. */
  claim(): Promise<boolean>;
  /** Called after synchronous speech suppression; rejection closes the transport. */
  readonly onInterruption?: (event: RelayInterruption) => void | Promise<void>;
  /** Called synchronously during construction while upgrade context is live. */
  waitUntil(task: Promise<void>): void;
  /** Metadata only. Exceptions from diagnostics do not interrupt the call. */
  readonly onDiagnostic?: (event: RelayDiagnostic) => void;
  /** Positive integer milliseconds, <= 2^31-1. Defaults to 270000. */
  readonly maxDurationMs?: number;
}
