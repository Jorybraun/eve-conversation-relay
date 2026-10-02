import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundCallRecord } from "@pipey/eve-conversation-relay/channel";

/** Single-host example store. Its file must survive process restarts. */
export function createSqliteCallStore(path: string, now: () => number = Date.now) {
  const filename = resolve(path);
  let database: DatabaseSync | undefined;

  function db(): DatabaseSync {
    if (!database) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      database = new DatabaseSync(filename);
      chmodSync(filename, 0o600);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS phone_calls (
          call_sid TEXT PRIMARY KEY,
          record_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          claimed_at INTEGER
        );
      `);
    }
    return database;
  }

  function read(callSid: string): InboundCallRecord | null {
    const row = db().prepare("SELECT record_json FROM phone_calls WHERE call_sid = ?").get(callSid);
    // Only putIfAbsent writes record_json; this is an application-owned database.
    return row ? JSON.parse(String(row.record_json)) as InboundCallRecord : null;
  }

  return {
    async putIfAbsent(record: InboundCallRecord): Promise<InboundCallRecord> {
      db().prepare(`INSERT INTO phone_calls (call_sid, record_json, expires_at)
        VALUES (?, ?, ?) ON CONFLICT (call_sid) DO NOTHING`)
        .run(record.call.callSid, JSON.stringify(record), record.expiresAt);
      const saved = read(record.call.callSid);
      if (!saved) throw new Error("Phone call could not be persisted.");
      return saved;
    },
    async get(callSid: string): Promise<InboundCallRecord | null> {
      return read(callSid);
    },
    async claimOnce(callSid: string): Promise<boolean> {
      const at = now();
      const result = db().prepare(`UPDATE phone_calls SET claimed_at = ?
        WHERE call_sid = ? AND claimed_at IS NULL AND expires_at > ?`)
        .run(at, callSid, at);
      return Number(result.changes) === 1;
    },
    close(): void {
      database?.close();
      database = undefined;
    },
  };
}
