import { conversationRelayChannel } from "@pipey/eve-conversation-relay/channel";
import { createSqliteCallStore } from "../../lib/sqlite-call-store.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.local before starting Eve.`);
  return value;
}

const allowedCallers = new Set(required("PHONE_ALLOWED_CALLERS").split(",").map(value => value.trim()));
if ([...allowedCallers].some(value => !/^\+[1-9]\d{7,14}$/.test(value))) {
  throw new Error("PHONE_ALLOWED_CALLERS must contain comma-separated E.164 numbers.");
}

// Opening SQLite is lazy: compiling the agent does not create a database.
const calls = createSqliteCallStore(process.env.PHONE_DATABASE_PATH || "./data/phone-calls.sqlite");

export default conversationRelayChannel({
  publicOrigin: required("PHONE_PUBLIC_ORIGIN"),
  accountSid: required("TWILIO_ACCOUNT_SID"),
  authToken: required("TWILIO_AUTH_TOKEN"),
  phoneNumber: required("TWILIO_PHONE_NUMBER"),
  route: "/phone",
  calls,
  speech: {
    stt: { provider: "Google", model: "telephony" },
    tts: { provider: "Amazon", voice: "Joanna-Neural" },
    language: "en-US",
    greeting: "Hello. I'm an AI helpdesk demo. Your speech will be transcribed to answer you. How can I help?",
    endMessage: "The demo call has ended. Goodbye.",
  },
  async authorize(call) {
    // Caller-ID filtering limits the demo; it does not establish a verified
    // customer identity or grant access to private accounts or shared memory.
    return allowedCallers.has(call.from) ? { auth: null } : null;
  },
});
