# Publishing the PIPEY phone library

`@pipey/eve-conversation-relay` is a proposed npm package, not a published release.
An npm scope must
belong to a user or organization that grants the publisher access. A package-name
404 does not establish ownership or availability of the organization itself.

## Review the release candidate

The manifest is prepared with version `0.1.0`, MIT licensing, public npm access,
compiled ESM exports and the tested Eve peer version. Only the library and its
fictional examples are included; publishing this package does not publish PIPEY's
application repository. The public source lives at
https://github.com/Jorybraun/eve-conversation-relay. Confirm npm scope ownership
before the first registry release.

If switching scope, update the package name, example imports/dependencies,
README commands and PIPEY's workspace dependency together, then regenerate the
lockfile and repeat the consumer check. Do not widen the Eve peer range without
checking the corresponding runtime version.

From this repository:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm pack --dry-run
```

The consumer check installs a packed artifact into a new temporary project using
npm. It validates declarations, a standalone Eve build, the sample call store
and simulated streaming. It prints the exact archive path and leaves the
temporary project for inspection. It is local evidence, not a provider test.

Run a supervised incoming call using the standalone starter. Verify two turns,
an interruption, hangup/cleanup and a rejected unauthorized caller. Record the
tested artifact checksum, Eve/Node versions, provider configuration and results
without credentials or personal transcript content. PIPEY's existing outgoing
flow should also be exercised against this artifact before replacing its deployed
version. Application-specific behavior needs its own acceptance checks.

The initial release receives an independent Devin Cloud SWE-2 review against a
committed source revision. Record the reviewed commit and actionable findings;
fix and recheck findings before announcing the release. A review does not replace
real-provider evidence.

## First public npm release

After the release candidate is accepted, a maintainer with access to the chosen
scope can run:

```sh
npm login
npm publish --access public
```

Run this inside **this repository directory**. Publishing runs
`prepublishOnly` (source checks plus the independent consumer check) and builds
the distributable through `prepack`. The registry enforces account authorization
and its current two-factor requirements. The command above performs the actual
public publication; none of the preparation commands publishes.

Verify the published version in another empty project:

```sh
npm install eve@0.63.0 @pipey/eve-conversation-relay@0.1.0
```

Repeat the starter's checks using the registry-installed package. Once a public
source repository and npm package exist, CI publishing can use npm trusted
publishing instead of a long-lived registry token. Do not configure a workflow
against a guessed repository, organization or package.

Official references: [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
