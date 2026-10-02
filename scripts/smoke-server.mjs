/** Start only the isolated fixture build; send no prompt to a model/provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const consumer = process.argv[2];
assert.ok(consumer, "Pass the independent fixture consumer directory");
const reservation = createServer();
await new Promise((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = "https://phone.example.test";
const token = "fictional-build-token";
const call = { AccountSid: `AC${"0".repeat(32)}`, CallSid: `CA${"1".repeat(32)}`, From: "+15005550007", To: "+15005550006", Direction: "inbound" };
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  cwd: consumer, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port),
    PHONE_PUBLIC_ORIGIN: publicOrigin, TWILIO_ACCOUNT_SID: call.AccountSid, TWILIO_AUTH_TOKEN: token,
    TWILIO_PHONE_NUMBER: call.To, PHONE_ALLOWED_CALLERS: call.From,
    PHONE_DATABASE_PATH: join(consumer, "http-fixture.sqlite"), AI_GATEWAY_API_KEY: "fictional-build-key",
  },
});
let output = "";
server.stdout.on("data", data => { output = (output + data).slice(-12_000); });
server.stderr.on("data", data => { output = (output + data).slice(-12_000); });
const exited = new Promise(resolve => server.once("exit", resolve));

function signature(url, form = {}) {
  const payload = url + Object.keys(form).sort().map(key => key + form[key]).join("");
  return createHmac("sha1", token).update(payload).digest("base64");
}
async function answer(form, signed) {
  return fetch(`${origin}/phone/answer`, {
    method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(5_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(signed ? { "X-Twilio-Signature": signature(`${publicOrigin}/phone/answer`, form) } : {}) },
  });
}
async function upgrade(signed) {
  const path = `/phone/stream/${call.CallSid}`;
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, {
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...(signed ? { "X-Twilio-Signature": signature(`wss://phone.example.test${path}`) } : {}),
      },
    });
    request.setTimeout(5_000, () => request.destroy(new Error("WebSocket upgrade timed out")));
    request.once("error", reject);
    request.once("response", response => { response.resume(); resolve(response.statusCode); });
    request.once("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    request.end();
  });
}

try {
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { healthy = true; break; }
    } catch { /* Wait only for the local server to bind. */ }
    await pause(100);
  }
  assert.ok(healthy, "Compiled server did not become healthy");
  const session = await fetch(`${origin}/eve/v1/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) });
  assert.equal(session.status, 401, "Starter must reject direct Eve session creation");
  assert.equal((await answer(call, false)).status, 403, "Unsigned phone webhook must be rejected");
  assert.equal((await answer({ ...call, From: "+15005550008" }, true)).status, 403, "Disallowed caller must be rejected");
  const accepted = await answer(call, true);
  assert.equal(accepted.status, 200, "Signed inbound webhook must answer");
  assert.match(await accepted.text(), new RegExp(`wss://phone.example.test/phone/stream/${call.CallSid}`));
  assert.equal(await upgrade(false), 403, "Unsigned socket upgrade must be rejected");
  assert.equal(await upgrade(true), 101, "Signed socket must upgrade on the real Eve server");
  console.log("PASS: compiled Eve server health, session API denial, webhook authorization, TwiML and signed WebSocket upgrade.");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  server.kill("SIGTERM");
  await Promise.race([exited, pause(2_000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await exited; }
}
