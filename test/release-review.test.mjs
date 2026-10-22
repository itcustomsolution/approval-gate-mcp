// Regressions from the independent release review of 0.4.0 (2026-10-22): durability of the spent state across a
// lost directory entry (AG-01) and bounded listing of a long history (AG-02). Synthetic state in a temp dir only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-release-review-"));
  process.env.APPROVAL_GATE_DIR = dir;
  store = await import("../dist/store.js");
});

test("AG-01: a consumed approval stays consumed when its .used marker is lost (modeled lost directory entry)", async () => {
  const r = await store.createRequest("synthetic no-op", "test fixture", 3600);
  await store.decide(r.id, true);
  const first = await store.consumeApproval(r.id, r.action);
  assert.equal(first.ok, true);
  const used = readdirSync(join(dir, "requests")).filter((f) => f.startsWith(r.id) && f.endsWith(".used"));
  assert.equal(used.length, 1);
  unlinkSync(join(dir, "requests", used[0]));
  const view = await store.getRequest(r.id);
  assert.equal(view.effectiveStatus, "consumed");
  assert.equal(view.authorizesExecution, false);
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
  await assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("must not run")));
});

test("AG-01: a revoked approval stays revoked when its .used marker is lost", async () => {
  const r = await store.createRequest("synthetic no-op", "test fixture", 3600);
  await store.decide(r.id, true);
  await store.revokeApproval(r.id);
  for (const f of readdirSync(join(dir, "requests"))) if (f.startsWith(r.id) && f.endsWith(".used")) unlinkSync(join(dir, "requests", f));
  assert.equal((await store.getRequest(r.id)).effectiveStatus, "revoked");
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});

test("AG-02: listing a long denied history returns only the page asked for, without payload text", async () => {
  const payload = { note: "x".repeat(4000) };
  for (let i = 0; i < 60; i++) {
    const r = await store.createRequest(`synthetic denied ${i}`, "test fixture", 3600, undefined, { payload });
    await store.decide(r.id, false);
  }
  const pending = await store.listRequestPage("pending", 1);
  assert.equal(pending.items.length, 0);
  const denied = await store.listRequestPage("denied", 5);
  assert.equal(denied.items.length, 5);
  assert.ok(denied.nextCursor);
  for (const item of denied.items) assert.equal("payloadCanonical" in item, false);
  const next = await store.listRequestPage("denied", 5, denied.nextCursor);
  assert.equal(next.items.length, 5);
  assert.notEqual(next.items[0].id, denied.items[0].id);
});

test("AG-02: streamed pages preserve total order, ties, filters and continuation without duplicates", async () => {
  const stamp = Date.now();
  for (let i = 0; i < 13; i++) {
    const r = await store.createRequest("page-order " + i, "synthetic fixture", 3600);
    await store.decide(r.id, i % 3 === 0);
    const file = join(dir, "requests", r.id + ".json");
    const row = JSON.parse(readFileSync(file, "utf8"));
    row.createdAt = new Date(stamp - (i % 4) * 1000).toISOString();
    writeFileSync(file, JSON.stringify(row));
  }
  // Compare against the public legacy full-list contract, across all records in this fixture.
  for (const status of [undefined, "denied", "approved"]) {
    const expected = (await store.listRequests(status)).map((row) => row.id);
    const seen = [];
    let cursor;
    do {
      const page = await store.listRequestPage(status, 2, cursor);
      assert.ok(page.items.length <= 2);
      assert.ok(page.items.every((row) => !("payloadCanonical" in row)));
      seen.push(...page.items.map((row) => row.id));
      assert.ok(seen.length <= expected.length, "continuation must make progress");
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, seen.length);
  }
  await assert.rejects(store.listRequestPage(undefined, 2, "ffffffffffff"), /unknown page cursor/);
});
