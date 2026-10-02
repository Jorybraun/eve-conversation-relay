# Contributing

This repository contains a standalone Eve transport library and an incoming-call
starter. Keep changes focused on the public API, Twilio ConversationRelay
transport, or the starter. Application identity, authorization, durable storage
and agent behavior belong to the consuming application.

## Develop locally

Use Node.js 24.16.0, matching CI, and npm. From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

`check` builds the library, typechecks its source and runs unit tests.
`test:package` packs the actual npm artifact, checks its contents and installs it
in a fresh temporary consumer outside this repository. It then typechecks and
tests the starter, runs the offline conversation simulation, builds the Eve app,
and checks its local HTTP/WebSocket routes. It needs npm registry access unless
dependencies are already cached. It uses fictional credentials and does not
place a phone call or publish anything.

For the shorter offline walkthrough, run `npm run demo`. For a supervised live
call, follow [the incoming-call starter instructions](examples/inbound/README.md)
using your own account and an authorized test caller.

## Propose a change

Open an issue before a large API change. In a pull request, describe the problem,
the resulting behavior, any compatibility change, and the verification performed.
Add focused tests for changed contracts, authorization, lifecycle or failure
behavior. Preserve the package's independent installation: avoid workspace links,
application imports and private Eve APIs. Changes to the supported Eve version
need both the package checks and the independent consumer check.

Distinguish evidence precisely:

| Evidence | What it establishes |
| --- | --- |
| Static | Source, API or configuration inspected without execution. |
| Local | Tests, simulations, builds or localhost routes exercised. CI belongs here. |
| Real-provider | A real Twilio/speech/model integration exercised with authorized credentials. |
| Deployed | Behavior exercised on a named hosted deployment. |

A passing simulation or localhost request does not establish speech quality,
carrier delivery, call latency or deployed behavior. Include the tested commit,
commands, outcomes and remaining gaps. Keep credentials, phone numbers belonging
to real people, transcripts and private account data out of fixtures, logs and
pull requests.

## Releases

CI verifies pull requests and pushes to `main`; it does not publish packages or
make provider calls. Maintainers review the package contents, compatibility and
verification evidence before a release. npm publication requires an authorized
package owner; a successful local `npm pack` is not a published release.
