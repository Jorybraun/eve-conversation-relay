# An Eve agent that answers a phone

This standalone helpdesk example consumes `@pipey/eve-conversation-relay` through
its public `/channel` entry point. It contains no PIPEY application imports.
It accepts incoming calls from a configured caller-ID allowlist, uses Twilio to
transcribe speech and speak replies, and gives the text conversation to Eve.
It does not dial anyone, send SMS, access customer accounts, or install tools.

The package supplies the signed HTTP/WebSocket routes and conversation handling.
This app supplies the agent, configuration, access policy and persistent call
store. See `agent/channels/phone.ts` for the complete consumer configuration.

## Install an independent copy

You need Node.js 24+, a Twilio Voice number with ConversationRelay available,
a model API credential and a public HTTPS endpoint that supports WebSockets.
Eve is pinned to `0.63.0`, the version this adapter has been tested against.

Before registry publication, use the package tarball supplied by its maintainer:

```sh
mkdir eve-phone
tar -xzf /absolute/path/pipey-eve-conversation-relay-0.1.0.tgz \
  -C eve-phone --strip-components=3 package/examples/inbound
cd eve-phone
npm install /absolute/path/pipey-eve-conversation-relay-0.1.0.tgz
cp .env.example .env.local
```

Installing the tarball replaces the adapter's registry dependency with that local
artifact. After publication, copying this directory and running `npm install`
will use the declared registry version. No registry publication is implied by
the files in this repository.

## Configure the application

Edit `.env.local`:

| Variable | Meaning |
| --- | --- |
| `PHONE_PUBLIC_ORIGIN` | Exact public HTTPS origin, such as the origin of your local tunnel; no path or query |
| `TWILIO_ACCOUNT_SID` | Account owning the number |
| `TWILIO_AUTH_TOKEN` | Account auth token for webhook signature verification |
| `TWILIO_PHONE_NUMBER` | Your Twilio number in E.164 format |
| `PHONE_ALLOWED_CALLERS` | Comma-separated E.164 caller IDs permitted to try this demo |
| `PHONE_DATABASE_PATH` | SQLite file; defaults to `./data/phone-calls.sqlite` |
| `PHONE_MODEL` | Eve AI Gateway model ID; defaults to `openai/gpt-5.6-luna-fast` |
| `AI_GATEWAY_API_KEY` | Credential for that model through AI Gateway |

The example uses Google `telephony` STT and Amazon `Joanna-Neural` TTS. Change
`speech` in `agent/channels/phone.ts` to select another supported Twilio provider
combination. Provider/model/voice availability depends on your Twilio account.

The caller-ID allowlist is a demo access filter, not proof of a person's identity.
The agent receives `auth: null` and has no customer data or privileged tools.
If you add those capabilities, provide your own verified identity flow through
`authorize`, along with the corresponding access checks.

## Start and connect Twilio

1. Run `npm run dev`. Eve listens on `127.0.0.1:2000` without its terminal UI.
2. Expose port 2000 using your chosen HTTPS tunnel with WebSocket support.
   Set `PHONE_PUBLIC_ORIGIN` to its exact HTTPS origin and restart Eve if it
   changed. Do not put a path prefix in this value.
3. In your Twilio number's Voice configuration, set **A call comes in** to a
   webhook, **POST**, at `https://YOUR_PUBLIC_ORIGIN/phone/answer`.
   Replace the entire origin placeholder with your configured origin.
4. From an allowed caller ID, call your Twilio number for a supervised test.
   The greeting identifies the demo as AI. A real call uses paid Twilio and model
   services; simply installing or running the tests does not place a call.

The answer route returns TwiML pointing at
`wss://YOUR_PUBLIC_ORIGIN/phone/stream/:callSid`. The adapter verifies the HTTP
signature against the public HTTPS answer URL and the socket signature against
the public WSS URL. Neither route accepts an unsigned request. Account, called
number and setup fields must match the stored call. Route names have no Eve
channel-name prefix.

This demo deliberately rejects direct Eve session API calls, including in local
development, so the tunnel exposes no anonymous alternative to the phone checks.
Health remains public. It has no interruption transcript callback: Eve retains
conversation events, but this example does not claim accurate playback receipts
or long-term customer memory.

## Local checks

```sh
npm run typecheck
npm test
npm run build
```

The four storage tests check durable claims after restart, duplicate webhook
behavior, one successful claim across two connections, and expiry/missing-call
rejection. They use fictional records in temporary databases and make no network
requests. Building requires the configuration variables above; a model key is
only needed when invoking the agent. A successful build does not prove a real
call, speech quality, carrier delivery, interruption timing, or provider access.

## Hosting and state ownership

This is a **single-host Node example**. For a self-hosted service, build with
`npm run build`, then run `npm start` behind a TLS reverse proxy that forwards
HTTP and WebSocket upgrades. Keep the same public origin at build/runtime.
Eve's `.eve/.workflow-data` and the directory holding `PHONE_DATABASE_PATH`
must live on persistent storage. Keep the app source, installed dependencies
and `.output` together. Forward custom `/phone/*` routes and Eve's runtime
routes, including `/.well-known/workflow/*` callbacks.

`lib/sqlite-call-store.ts` owns the call records and connection claims. SQLite
opens lazily, uses an atomic claim update, and keeps the original record when a
webhook is retried. Expired records stay as replay tombstones; deleting them
without another replay protection mechanism can admit an old signed request
again. The database contains phone numbers and must remain private. This small
example does not implement a production retention/redaction policy.

The default call eligibility window is ten minutes; a connected relay lasts at
most 270 seconds. A disconnect does not release its claim. Reconnecting the same
call is intentionally unsupported; a new phone call gets a fresh Eve address.
No status callback is wired in this minimal example. Authorization is checked
again before each utterance; the configured allowlist changes after a restart.

Do not deploy this SQLite file to an ephemeral serverless filesystem or share it
between independent hosts. Use a shared durable store with the same atomic
contract for that deployment. Vercel WebSocket functions also require a suitable
host lifetime callback (for example `@vercel/functions`' `waitUntil`) and duration
configuration. Neither is configured by this Node starter.

The application operator owns model credentials, Twilio configuration, storage,
access policy and deployment. The library owns only the transport adapter.

References: [Eve custom channels](https://github.com/vercel/eve/blob/main/packages/eve/docs/channels/custom.mdx),
[Eve self-hosting](https://github.com/vercel/eve/blob/main/packages/eve/docs/guides/deployment/self-hosting.md),
[Twilio ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay).
