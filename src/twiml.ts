export interface SpeechToTextConfig {
  readonly provider: "Deepgram" | "Google";
  /** A model supported by this provider and language in ConversationRelay. */
  readonly model: string;
  readonly language?: string;
}

export interface TextToSpeechConfig {
  readonly provider: "Google" | "Amazon" | "ElevenLabs";
  /** Provider-specific voice ID; availability is checked by Twilio at call time. */
  readonly voice: string;
  readonly language?: string;
}

export interface ConversationRelayTwimlOptions {
  readonly streamUrl: string;
  readonly stt: SpeechToTextConfig;
  readonly tts: TextToSpeechConfig;
  readonly language?: string;
  readonly greeting?: string;
  readonly endMessage?: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Build speech configuration for the managed ConversationRelay transport. */
export function buildConversationRelayTwiml(options: ConversationRelayTwimlOptions): string {
  const url = new URL(options.streamUrl);
  if (url.protocol !== "wss:" || url.username || url.password || url.hash) {
    throw new TypeError("ConversationRelay requires a WSS URL without credentials or fragment");
  }
  if (!["Deepgram", "Google"].includes(options.stt.provider) ||
      !["Google", "Amazon", "ElevenLabs"].includes(options.tts.provider)) {
    throw new TypeError("Unsupported ConversationRelay speech provider");
  }
  if (!options.stt.model.trim() || !options.tts.voice.trim()) {
    throw new TypeError("Speech model and voice must be nonempty");
  }
  const language = options.language ?? "en-US";
  if ((options.stt.language ?? language) === "multi" && options.stt.provider !== "Deepgram") {
    throw new TypeError("Multilingual transcription requires Deepgram");
  }
  if ((options.tts.language ?? language) === "multi" && options.tts.provider !== "ElevenLabs") {
    throw new TypeError("Multilingual synthesis requires ElevenLabs");
  }
  const attributes: Record<string, string> = {
    url: options.streamUrl,
    interruptible: "speech",
    reportInputDuringAgentSpeech: "speech",
    interruptSensitivity: "medium",
    transcriptionProvider: options.stt.provider,
    speechModel: options.stt.model,
    ttsProvider: options.tts.provider,
    voice: options.tts.voice,
    language,
  };
  // Flux supports interim prompts; this relay only dispatches finalized speech.
  if (options.stt.provider === "Deepgram" && options.stt.model === "flux") attributes.partialPrompts = "false";
  if (options.stt.language) attributes.transcriptionLanguage = options.stt.language;
  if (options.tts.language) attributes.ttsLanguage = options.tts.language;
  if (options.greeting !== undefined) {
    attributes.welcomeGreeting = options.greeting;
    attributes.welcomeGreetingInterruptible = "any";
  }
  const serialized = Object.entries(attributes).map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ");
  const farewell = options.endMessage === undefined ? "" : `<Say>${escapeXml(options.endMessage)}</Say>`;
  return `<Response><Connect><ConversationRelay ${serialized} /></Connect>${farewell}<Hangup/></Response>`;
}
