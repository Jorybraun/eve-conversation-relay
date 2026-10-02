import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InboundCallRecord } from "@pipey/eve-conversation-relay/channel";
import { createSqliteCallStore } from "../lib/sqlite-call-store.ts";

function fixture(): InboundCallRecord {
  return {
    call: {
      accountSid: `AC${"0".repeat(32)}`,
      callSid: `CA${"1".repeat(32)}`,
      from: "+12025550101",
      to: "+12025550100",
    },
    auth: null,
    createdAt: 1_000,
    expiresAt: 10_000,
  };
}

test("inbound_example_persists_call_and_claim_across_restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "eve-phone-store-"));
  const file = join(folder, "calls.sqlite");
  const record = fixture();
  const first = createSqliteCallStore(file, () => 2_000);
  const second = createSqliteCallStore(file, () => 3_000);
  try {
    await first.putIfAbsent(record);
    assert.equal(await first.claimOnce(record.call.callSid), true);
    first.close();
    assert.deepEqual(await second.get(record.call.callSid), record);
    assert.equal(await second.claimOnce(record.call.callSid), false);
  } finally {
    first.close();
    second.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("inbound_example_duplicate_webhook_preserves_original_record", async () => {
  const folder = mkdtempSync(join(tmpdir(), "eve-phone-store-"));
  const store = createSqliteCallStore(join(folder, "calls.sqlite"), () => 2_000);
  const record = fixture();
  try {
    await store.putIfAbsent(record);
    const duplicate = { ...record, expiresAt: 30_000, context: ["different"] };
    assert.deepEqual(await store.putIfAbsent(duplicate), record);
    assert.deepEqual(await store.get(record.call.callSid), record);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("inbound_example_two_connections_have_one_claim_winner", async () => {
  const folder = mkdtempSync(join(tmpdir(), "eve-phone-store-"));
  const file = join(folder, "calls.sqlite");
  const first = createSqliteCallStore(file, () => 2_000);
  const second = createSqliteCallStore(file, () => 2_000);
  const record = fixture();
  try {
    await first.putIfAbsent(record);
    const claims = await Promise.all([
      first.claimOnce(record.call.callSid),
      second.claimOnce(record.call.callSid),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
  } finally {
    first.close();
    second.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("inbound_example_rejects_expired_and_unknown_call_claims", async () => {
  const folder = mkdtempSync(join(tmpdir(), "eve-phone-store-"));
  const store = createSqliteCallStore(join(folder, "calls.sqlite"), () => 10_000);
  const record = fixture();
  try {
    await store.putIfAbsent(record);
    assert.equal(await store.claimOnce(record.call.callSid), false);
    assert.equal(await store.claimOnce(`CA${"9".repeat(32)}`), false);
    // Retain the expired row: replay must not reset its expiry or call claim.
    assert.deepEqual(await store.get(record.call.callSid), record);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
