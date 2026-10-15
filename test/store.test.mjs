// Light behavior tests for the approval store. Uses only node:test; runs against dist/.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store;
before(async () => {
  process.env.APPROVAL_GATE_DIR = mkdtempSync(join(tmpdir(), "approval-gate-test-"));
  store = await import("../dist/store.js");
});

test("new requests start pending (not approved)", async () => {
  const r = await store.createRequest("send test email", "testing", 3600, "test");
  assert.equal(r.status, "pending");
  assert.equal((await store.getRequest(r.id)).status, "pending");
});

test("approve and deny are recorded and final", async () => {
  const a = await store.createRequest("a", "r", 3600);
  assert.equal((await store.decide(a.id, true, "ok")).status, "approved");
  await assert.rejects(store.decide(a.id, false), /already approved/);
  const d = await store.createRequest("d", "r", 3600);
  assert.equal((await store.decide(d.id, false, "no")).status, "denied");
});

test("expired requests fail closed and cannot be approved", async () => {
  const r = await store.createRequest("late", "r", -1);
  assert.equal((await store.getRequest(r.id)).status, "expired");
  await assert.rejects(store.decide(r.id, true), /already expired/);
});

test("unknown and path-traversal ids are not found", async () => {
  assert.equal(await store.getRequest("does-not-exist"), undefined);
  assert.equal(await store.getRequest("../../etc/passwd"), undefined);
  await assert.rejects(store.decide("nope", true), /No request/);
});

test("every event is appended to the audit log", async () => {
  const log = readFileSync(join(process.env.APPROVAL_GATE_DIR, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const events = new Set(log.map((e) => e.event));
  for (const e of ["requested", "approved", "denied", "expired"]) assert.ok(events.has(e), e);
});
