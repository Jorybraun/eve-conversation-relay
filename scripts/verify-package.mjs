/** Test the actual npm tarball in a fresh consumer outside this repository. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "pipey-npm-consumer-"));
const artifacts = join(scratch, "artifacts");
const unpacked = join(scratch, "unpacked");
const consumer = join(scratch, "consumer");
mkdirSync(artifacts);
mkdirSync(unpacked);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd, encoding: "utf8", stdio: "inherit", timeout: 300_000, ...options,
  });
}

console.log(`Checking ${manifest.name}@${manifest.version} with ${process.version}`);
console.log(`Independent consumer: ${consumer}`);
run(npm, ["run", "build"], source);
// Build explicitly once; inspect the same archive that will be installed.
const [packed] = JSON.parse(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], source, { stdio: "pipe" }));
const files = packed.files.map(file => file.path);
for (const path of files) {
  const expected = ["package.json", "README.md", "LICENSE"].includes(path)
    || /^dist\/[^/]+\.(js|d\.ts)$/.test(path)
    || /^examples\/.+\.(ts|mts|mjs|json|md)$/.test(path)
    || /^examples\/.+\/(\.env\.example|\.gitignore)$/.test(path);
  assert.ok(expected, `Unexpected published file: ${path}`);
  assert.ok(!/(^|\/)(node_modules|\.eve|\.vercel|\.git)(\/|$)/.test(path), `Generated/private directory: ${path}`);
  assert.ok(!/(^|\/)\.env($|\.(?!example$))/.test(path), `Environment file: ${path}`);
}
for (const required of ["LICENSE", "dist/index.js", "dist/index.d.ts", "dist/channel.js", "dist/channel.d.ts", "examples/inbound/package.json", "examples/inbound/.env.example"]) {
  assert.ok(files.includes(required), `Missing published file: ${required}`);
}
for (const group of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  for (const version of Object.values(manifest[group] ?? {})) assert.ok(!/^(workspace|link|file):/.test(version), `Local ${group} escaped into published metadata`);
}
const archive = join(artifacts, packed.filename);
run("tar", ["-xzf", archive, "-C", unpacked], source);
cpSync(join(unpacked, "package/examples/inbound"), consumer, { recursive: true });
const consumerManifestPath = join(consumer, "package.json");
const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, "utf8"));
assert.equal(consumerManifest.dependencies.eve, manifest.peerDependencies.eve);
consumerManifest.dependencies[manifest.name] = `file:${archive}`;
writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);

// Install public runtime dependencies plus our artifact; use no workspace links.
// Dependency install hooks are unnecessary for this fixture and stay disabled.
run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", ...(process.argv.includes("--offline") ? ["--offline"] : [])], consumer);
const installed = realpathSync(join(consumer, "node_modules", manifest.name));
assert.ok(!installed.startsWith(realpathSync(source)), "Consumer resolved to the source workspace");
assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, manifest.version);
run(npm, ["run", "typecheck"], consumer);
run(npm, ["test"], consumer);
cpSync(join(installed, "examples/simulate-call.ts"), join(consumer, "simulate-call.mts"));
run(process.execPath, ["simulate-call.mts"], consumer);
run(npm, ["run", "build"], consumer, {
  env: {
    ...process.env,
    // Compile-time fixtures only. No provider requests or live credentials.
    PHONE_PUBLIC_ORIGIN: "https://phone.example.test",
    TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "fictional-build-token",
    TWILIO_PHONE_NUMBER: "+15005550006",
    PHONE_ALLOWED_CALLERS: "+15005550007",
    AI_GATEWAY_API_KEY: "fictional-build-key",
    PHONE_DATABASE_PATH: join(consumer, "fixture.sqlite"),
  },
});
run(process.execPath, [join(source, "scripts/smoke-server.mjs"), consumer], consumer);
console.log(`PASS: npm tarball contents, independent install, types, starter tests, simulation, Eve build and HTTP/WebSocket smoke.\nArtifact: ${archive}`);
console.log("Local verification only: no live speech provider, telephone call, registry publication or deployment.");
