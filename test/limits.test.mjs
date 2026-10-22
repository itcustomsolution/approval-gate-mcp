// AG-05 bounded input/queue/output, TTL compatibility, archive retention, RFC 8785 canonical payloads.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store, dir;
before(async () => {
  store = await import("../dist/store.js");
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-limits-"));
  process.env.APPROVAL_GATE_DIR = dir;
  delete process.env.APPROVAL_GATE_MAX_PENDING;
});
const reqFile = (id) => join(dir, "requests", `${id}.json`);
const edit = (id, patch) => writeFileSync(reqFile(id), JSON.stringify({ ...JSON.parse(readFileSync(reqFile(id), "utf8")), ...patch }));

test("text limits are UTF-8 bytes and apply to library callers", async () => {
  const { LIMITS } = store;
  await store.createRequest("a".repeat(LIMITS.action), "r", 60);
  await assert.rejects(store.createRequest("a".repeat(LIMITS.action + 1), "r", 60), /action must be/);
  await assert.rejects(store.createRequest("\u20ac".repeat(2731), "r", 60), /at most 8192 UTF-8 bytes/); // 8193 bytes
  await assert.rejects(store.createRequest("a", "r".repeat(LIMITS.reason + 1), 60), /reason/);
  await assert.rejects(store.createRequest("a", "r", 60, "x".repeat(257)), /requestedBy/);
  await assert.rejects(store.createRequest("", "r", 60), /nonempty/);
  for (const op of ["", "has space", "-leading", "a".repeat(129), "esc\u001b"]) await assert.rejects(store.createRequest("a", "r", 60, undefined, { operation: op }), /operation must be/);
  await assert.rejects(store.consumeApproval("aaaaaaaaaaaa", "a".repeat(LIMITS.action + 1)), /action must be/);
  const r = await store.createRequest("a", "r", 60);
  await assert.rejects(store.decide(r.id, false, "x".repeat(LIMITS.reason + 1)), /decision reason/);
});

test("TTL: library keeps 0.x compatibility for short/negative TTLs but caps at 7 days and rejects non-finite", async () => {
  const expired = await store.createRequest("a", "r", -1);
  assert.equal((await store.getRequest(expired.id)).status, "expired");
  const short = await store.createRequest("a", "r", 0.5);
  assert.equal((await store.getRequest(short.id)).status, "pending");
  await store.createRequest("a", "r", 7 * 24 * 3600);
  for (const ttl of [7 * 24 * 3600 + 1, Infinity, NaN, "60", undefined]) await assert.rejects(store.createRequest("a", "r", ttl), /ttlSeconds/);
});

test("the worst-case record (every field at its limit, maximal JSON escaping) still persists, decides and consumes", async () => {
  const { LIMITS } = store;
  const ctl = (n) => "\u0001".repeat(n); // 1 byte each, 6 bytes once JSON-escaped
  const payload = ["\\\"".repeat((LIMITS.payloadBytes - 16) / 4)]; // canonical text is all backslashes and quotes
  const r = await store.createRequest(ctl(LIMITS.action), ctl(LIMITS.reason), 60, ctl(LIMITS.requestedBy), { operation: "x".repeat(LIMITS.operation), payload });
  await store.decide(r.id, true, ctl(LIMITS.reason));
  assert.equal((await store.consumeApproval(r.id, ctl(LIMITS.action), { operation: "x".repeat(LIMITS.operation), payload })).ok, true);
});

test("payload canonicalization follows RFC 8785 and rejects non-JSON or oversized values", () => {
  const { canonicalJson, LIMITS } = store;
  // RFC 8785 section 3.2.3 property-sorting example (UTF-16 code unit order).
  const keys = { "\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\ud83d\ude00": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis" };
  const order = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
  assert.equal(canonicalJson(keys), `{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(keys[k])}`).join(",")}}`);
  assert.equal(canonicalJson({ b: [1, -0, 1e21, 0.1, "\u2028"], a: null }), '{"a":null,"b":[1,0,1e+21,0.1,"\u2028"]}');
  assert.equal(canonicalJson({ y: 1, x: { d: 2, c: 3 } }), canonicalJson({ x: { c: 3, d: 2 }, y: 1 }));
  // OM-05: an own "__proto__" key would set a prototype when trusted code copies the payload; refused at any depth.
  for (const raw of ['{"__proto__":{"polluted":1}}', '{"a":[{"__proto__":1}]}']) assert.throws(() => canonicalJson(JSON.parse(raw)), /__proto__/);
  const deep = (n) => (n === 0 ? 1 : [deep(n - 1)]);
  canonicalJson(deep(LIMITS.payloadDepth));
  const sparse = [1];
  sparse[2] = 3;
  const bad = [NaN, Infinity, () => 1, new Date(0), Symbol("s"), 10n, { u: undefined }, "\ud800", { "\udc00": 1 }, sparse, deep(LIMITS.payloadDepth + 1),
    Array.from({ length: LIMITS.payloadValues }, () => 0), "x".repeat(LIMITS.payloadBytes), Object.defineProperty({}, "g", { get: () => 1, enumerable: true }), new Map()];
  for (const v of bad) assert.throws(() => canonicalJson(v), /payload/, String(typeof v));
});

test("a hand-edited payload that no longer matches its digest reads as missing (fail closed)", async () => {
  const r = await store.createRequest("a", "r", 60, undefined, { payload: { amount: 1 } });
  await store.decide(r.id, true);
  edit(r.id, { payloadCanonical: '{"amount":1000}' });
  assert.equal(await store.getRequest(r.id), undefined);
  assert.deepEqual(await store.consumeApproval(r.id, "a", { payload: { amount: 1000 } }), { ok: false, error: "not_found" });
});

test("queue bound: APPROVAL_GATE_MAX_PENDING caps requests awaiting a human; decided and expired ones free space", async () => {
  process.env.APPROVAL_GATE_MAX_PENDING = "3";
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await store.createRequest(`a${i}`, "r", 3600)).id);
  await assert.rejects(store.createRequest("a3", "r", 3600), /approval queue full/);
  await store.decide(ids[0], false);
  const stale = await store.createRequest("short", "r", 0.2);
  await assert.rejects(store.createRequest("a4", "r", 3600), /queue full/);
  await new Promise((r) => setTimeout(r, 300));
  await store.createRequest("a5", "r", 3600); // the stale pending request is swept to expired
  assert.equal((await store.getRequest(stale.id)).status, "expired");
});

test("invalid queue configuration fails closed for writes, reads and consumption", async () => {
  const r = await store.createRequest("a", "r", 60);
  await store.decide(r.id, true);
  for (const v of ["0", "-1", "10001", "1e3", "abc", ""]) {
    process.env.APPROVAL_GATE_MAX_PENDING = v;
    await assert.rejects(store.createRequest("b", "r", 60), /APPROVAL_GATE_MAX_PENDING/);
    await assert.rejects(store.getRequest(r.id), /APPROVAL_GATE_MAX_PENDING/);
    await assert.rejects(store.consumeApproval(r.id, "a"), /APPROVAL_GATE_MAX_PENDING/);
  }
  delete process.env.APPROVAL_GATE_MAX_PENDING;
  assert.equal((await store.consumeApproval(r.id, "a")).ok, true);
});

test("pagination: bounded pages, oldest first, explicit cursor, summaries without payload text", async () => {
  const made = [];
  for (let i = 0; i < 7; i++) {
    made.push((await store.createRequest(`page item ${i}`, "r", 3600, undefined, { payload: { i } })).id);
    await new Promise((r) => setTimeout(r, 3)); // distinct createdAt
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.listRequestPage("pending", 3, cursor);
    pages++;
    assert.ok(page.items.length <= 3);
    for (const item of page.items) {
      assert.equal("payloadCanonical" in item, false);
      assert.match(item.payloadDigest, /^[0-9a-f]{64}$/);
      assert.equal(item.authorizesExecution, false);
      seen.push(item.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, made);
  assert.equal((await store.listRequestPage("pending", 7)).nextCursor, undefined);
  for (const limit of [0, 101, 1.5, "3"]) await assert.rejects(store.listRequestPage("pending", limit), /limit/);
  await assert.rejects(store.listRequestPage("pending", 3, "../x"), /invalid page cursor/);
  await assert.rejects(store.listRequestPage("pending", 3, "ffffffffffff"), /unknown page cursor/);
  await assert.rejects(store.listRequestPage("bogus"), /invalid request status/);
});

test("listRequests keeps its 0.x contract: every match, oldest first (not silently truncated)", async () => {
  for (let i = 0; i < 55; i++) await store.createRequest(`bulk ${i}`, "r", 3600);
  const all = await store.listRequests("pending");
  assert.equal(all.length, 55);
  assert.deepEqual(all.map((r) => r.createdAt), [...all.map((r) => r.createdAt)].sort());
});

test("archive moves only old, long-expired terminal requests; archived requests can never be consumed", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const oldExpiry = new Date(Date.now() - 40 * 86_400_000 + 3_600_000).toISOString();
  const denied = await store.createRequest("old denied", "r", 3600);
  await store.decide(denied.id, false);
  edit(denied.id, { createdAt: old, expiresAt: oldExpiry });
  const consumed = await store.createRequest("old consumed", "r", 3600);
  await store.decide(consumed.id, true);
  await store.consumeApproval(consumed.id, "old consumed");
  edit(consumed.id, { createdAt: old, expiresAt: oldExpiry });
  // A record from a version without the TTL cap: old and terminal, but its deadline has not passed.
  const legacy = await store.createRequest("legacy long ttl", "r", 3600);
  await store.decide(legacy.id, false);
  edit(legacy.id, { createdAt: old });
  const usable = await store.createRequest("old but still usable", "r", 3600);
  await store.decide(usable.id, true);
  edit(usable.id, { createdAt: old });
  const pending = await store.createRequest("pending", "r", 3600);
  const recentDenied = await store.createRequest("recent denied", "r", 3600);
  await store.decide(recentDenied.id, false);

  for (const days of [7, 0, -1, 1.5]) await assert.rejects(store.archiveRequests(days), /olderThanDays/);
  assert.equal(await store.archiveRequests(30), 2);
  const remaining = readdirSync(join(dir, "requests"));
  assert.ok(!remaining.some((f) => f.startsWith(denied.id) || f.startsWith(consumed.id)));
  assert.ok(existsSync(join(dir, "archive", `${consumed.id}.used`)));
  assert.equal(await store.getRequest(consumed.id), undefined);
  assert.deepEqual(await store.consumeApproval(consumed.id, "old consumed"), { ok: false, error: "not_found" });
  for (const keep of [usable.id, pending.id, recentDenied.id, legacy.id]) assert.ok(await store.getRequest(keep));
  assert.equal((await store.consumeApproval(usable.id, "old but still usable")).ok, true);
});
