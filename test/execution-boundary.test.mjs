// Execution-boundary regressions (AG-01 fabricated/stale/replayed grants, AG-02 expiry after awaited
// persistence, payload/operation binding, concurrency, persistence failures, crash semantics).
// Synthetic state in temp dirs only; no real actions. Delays/failures are injected by patching
// FileHandle.prototype in this test process, never by hooks in production code.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, promises as fsp } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const storeUrl = pathToFileURL(join(root, "dist/store.js")).href;
let store, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-exec-"));
  process.env.APPROVAL_GATE_DIR = dir;
  store = await import("../dist/store.js");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auditEvents = () => readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
async function approved(action = "synthetic no-op", ttl = 3600, binding) {
  const r = await store.createRequest(action, "test fixture", ttl, undefined, binding);
  await store.decide(r.id, true);
  return r;
}

/** Patch every FileHandle: onWrite may return an Error to fail that write; onSync may delay. */
async function withHandles({ onWrite, onSync }, fn) {
  const fh = await fsp.open(process.execPath, "r");
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  const { writeFile, sync } = proto;
  const last = new WeakMap();
  proto.writeFile = async function (data, ...rest) {
    const s = String(data);
    const fail = onWrite?.(s);
    if (fail) throw fail;
    last.set(this, s);
    return writeFile.call(this, data, ...rest);
  };
  proto.sync = async function () {
    await onSync?.(last.get(this) ?? "");
    return sync.call(this);
  };
  try {
    return await fn();
  } finally {
    proto.writeFile = writeFile;
    proto.sync = sync;
  }
}

test("AG-01: a fully shaped grant built by anyone else is refused, even for a real consumed request", async () => {
  const r = await approved("pay synthetic invoice A");
  const genuine = await store.consumeApproval(r.id, r.action);
  assert.equal(genuine.ok, true);
  const fabricated = { ok: true, id: r.id, action: r.action, consumedAt: genuine.consumedAt, expiresAt: genuine.expiresAt };
  assert.throws(() => store.assertConsumed(fabricated, r.id, r.action), /only a grant issued by consumeApproval/);
  assert.throws(() => store.assertConsumed(JSON.parse(JSON.stringify(genuine)), r.id, r.action), /never authority/);
  assert.throws(() => store.assertConsumed({ ...genuine }, r.id, r.action), /never authority/);
  // The audit's original reproduction: no request at all, nonsense timestamps.
  assert.throws(() => store.assertConsumed({ ok: true, id: "aaaaaaaaaaaa", action: "synthetic no-op", consumedAt: "not a date" }, "aaaaaaaaaaaa", "synthetic no-op"));
  assert.throws(() => store.assertConsumed({ ok: true, id: "bbbbbbbbbbbb", action: "x", consumedAt: "2000-01-01T00:00:00Z", expiresAt: "2000-01-01T00:00:01Z" }, "bbbbbbbbbbbb", "x"));
  for (const bad of [null, undefined, "ok", 1, true]) assert.throws(() => store.assertConsumed(bad, r.id, r.action));
});

test("AG-01: a genuine grant is accepted once; presenting it again (replay) is refused", async () => {
  const r = await approved("pay synthetic invoice B");
  const c = await store.consumeApproval(r.id, r.action);
  store.assertConsumed(c, r.id, r.action);
  assert.throws(() => store.assertConsumed(c, r.id, r.action), /once/);
});

test("AG-01: action substitution burns the grant and refuses", async () => {
  const r = await approved("email synthetic alice");
  const c = await store.consumeApproval(r.id, r.action);
  assert.throws(() => store.assertConsumed(c, r.id, "email synthetic everyone"), /different request or action/);
  assert.throws(() => store.assertConsumed(c, r.id, r.action), /once/);
});

test("AG-01: a genuine grant presented after expiry is refused", async () => {
  const r = await approved("short-lived synthetic action", 3);
  const c = await store.consumeApproval(r.id, r.action);
  assert.equal(c.ok, true);
  await sleep(3100);
  assert.throws(() => store.assertConsumed(c, r.id, r.action), /expired/);
});

test("AG-01: a consume result received over MCP (JSON) is never accepted as a grant", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { ...process.env, APPROVAL_GATE_DIR: dir };
  delete env.APPROVAL_GATE_ALLOW_MCP_APPROVE;
  const client = new Client({ name: "synthetic-agent", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], env, stderr: "ignore" }));
  try {
    const req = JSON.parse((await client.callTool({ name: "request_approval", arguments: { action: "synthetic mcp action", reason: "fixture" } })).content[0].text);
    await store.decide(req.id, true); // the human side, out of band
    const c = JSON.parse((await client.callTool({ name: "consume_approval", arguments: { id: req.id, action: "synthetic mcp action" } })).content[0].text);
    assert.equal(c.ok, true);
    assert.throws(() => store.assertConsumed(c, req.id, "synthetic mcp action"), /never authority/);
  } finally {
    await client.close();
  }
});

test("executeApproved runs the callback once, with a frozen copy of the APPROVED payload", async () => {
  const payload = { to: "alice@example.invalid", subject: "Synthetic invoice", lines: [{ sku: "A-1", qty: 2 }] };
  const r = await approved("send synthetic invoice email", 3600, { operation: "smtp.send", payload });
  const presented = { lines: [{ qty: 2, sku: "A-1" }], subject: "Synthetic invoice", to: "alice@example.invalid" }; // same JSON, different key order
  let calls = 0;
  const value = await store.executeApproved(r.id, { action: r.action, operation: "smtp.send", payload: presented }, (ctx) => {
    calls++;
    assert.equal(ctx.operation, "smtp.send");
    assert.deepEqual(ctx.payload, payload);
    assert.notEqual(ctx.payload, presented);
    assert.ok(Object.isFrozen(ctx.payload) && Object.isFrozen(ctx.payload.lines[0]) && Object.isFrozen(ctx));
    assert.equal(ctx.payloadDigest, r.payloadDigest);
    ctx.assertActive();
    return "sent (synthetic)";
  });
  assert.equal(value, "sent (synthetic)");
  assert.equal(calls, 1);
  const events = auditEvents().filter((e) => e.id === r.id).map((e) => e.event);
  assert.deepEqual(events.slice(-3), ["consumed", "execution_started", "execution_finished"]);
});

test("executeApproved refuses substituted, missing or unbound payloads and operations before claiming", async () => {
  const payload = { amount: 100, currency: "USD", payee: "synthetic-vendor" };
  const r = await approved("pay synthetic vendor", 3600, { operation: "payments.send", payload });
  const never = () => assert.fail("callback must not run");
  const cases = [
    [{ action: r.action, operation: "payments.send", payload: { ...payload, amount: 1000 } }, /payload_mismatch/],
    [{ action: r.action, operation: "payments.send" }, /payload_mismatch/],
    [{ action: r.action, operation: "payments.refund", payload }, /operation_mismatch/],
    [{ action: r.action, payload }, /operation_mismatch/],
    [{ action: "pay synthetic vendor twice", operation: "payments.send", payload }, /action_mismatch/],
  ];
  for (const [binding, re] of cases) await assert.rejects(store.executeApproved(r.id, binding, never), re);
  // Nothing was burned by those refusals; the exact binding still works, once.
  let ran = 0;
  await store.executeApproved(r.id, { action: r.action, operation: "payments.send", payload }, () => ran++);
  assert.equal(ran, 1);
  // A text-only approval cannot be stretched to cover a payload or operation it never showed the human.
  const plain = await approved("plain synthetic action");
  await assert.rejects(store.executeApproved(plain.id, { action: plain.action, payload: { any: 1 } }, never), /payload_not_bound/);
  await assert.rejects(store.executeApproved(plain.id, { action: plain.action, operation: "x.y" }, never), /operation_not_bound/);
});

test("repeated consumption: a spent approval cannot run again through either path", async () => {
  const r = await approved("synthetic single use");
  await store.executeApproved(r.id, { action: r.action }, () => {});
  await assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("replayed")), /not_usable|already_used/);
  const again = await store.consumeApproval(r.id, r.action);
  assert.deepEqual([again.ok, again.effectiveStatus], [false, "consumed"]);
});

test("concurrent in-process executors: exactly one callback runs", async () => {
  const r = await approved("synthetic concurrent action");
  let calls = 0;
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.executeApproved(r.id, { action: r.action }, () => ++calls)));
  assert.equal(calls, 1);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
});

test("concurrent consumers in separate processes: exactly one wins", async () => {
  const r = await approved("synthetic cross-process action");
  const code = `const s = await import(${JSON.stringify(storeUrl)}); const c = await s.consumeApproval(${JSON.stringify(r.id)}, ${JSON.stringify(r.action)}); console.log(JSON.stringify({ ok: c.ok }));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, APPROVAL_GATE_DIR: dir } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("close", (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${status}`))));
    });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(results.filter((x) => x.ok).length, 1);
});

test("persistence failure: unwritable audit during consume refuses and keeps the approval spent", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip();
  const r = await approved("synthetic audit failure");
  await fsp.chmod(join(dir, "audit.jsonl"), 0o400);
  try {
    await assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("must not run")), /audit_failed/);
  } finally {
    await fsp.chmod(join(dir, "audit.jsonl"), 0o600);
  }
  assert.equal((await store.getRequest(r.id)).effectiveStatus, "consumed");
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});

test("persistence failure: the request record write failing after the claim refuses", async () => {
  const r = await approved("synthetic record failure");
  const res = await withHandles({ onWrite: (s) => (s.includes('"consumedAt"') ? new Error("synthetic EIO") : undefined) }, () =>
    store.consumeApproval(r.id, r.action),
  );
  assert.deepEqual([res.ok, res.error], [false, "audit_failed"]);
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});

test("persistence failure: if execution_started cannot be recorded, nothing runs and the approval stays spent", async () => {
  const r = await approved("synthetic start-record failure");
  await withHandles({ onWrite: (s) => (s.includes('"event":"execution_started"') ? new Error("synthetic ENOSPC") : undefined) }, () =>
    assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("must not run")), /nothing was executed/),
  );
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});

test("AG-02: audit persistence that crosses expiry returns approval_expired, not a grant, and stays burned", async () => {
  const r = await approved("synthetic slow persistence", 3);
  const res = await withHandles({ onSync: (s) => (s.includes('"event":"consumed"') ? sleep(3300) : undefined) }, () => store.consumeApproval(r.id, r.action));
  assert.equal(Date.now() > Date.parse(r.expiresAt), true);
  assert.deepEqual([res.ok, res.error, res.effectiveStatus], [false, "approval_expired", "consumed"]);
  assert.ok(auditEvents().some((e) => e.id === r.id && e.event === "consume_rejected_expired" && e.phase === "after_persistence"));
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
  await assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("must not run")));
});

test("AG-02: execution_started persistence that crosses expiry stops before the side effect", async () => {
  const r = await approved("synthetic slow start record", 5);
  await withHandles({ onSync: (s) => (s.includes('"event":"execution_started"') ? sleep(5300) : undefined) }, () =>
    assert.rejects(store.executeApproved(r.id, { action: r.action }, () => assert.fail("must not run")), /expired before execution/),
  );
  assert.ok(auditEvents().some((e) => e.id === r.id && e.event === "execution_refused"));
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});

test("assertActive inside the callback catches expiry after the callback's own await", async () => {
  const r = await approved("synthetic long callback", 3);
  await assert.rejects(
    store.executeApproved(r.id, { action: r.action }, async (ctx) => {
      await sleep(3200);
      ctx.assertActive(); // the side effect would follow here
      assert.fail("side effect reached after expiry");
    }),
    /expired before execution/,
  );
  const finished = auditEvents().find((e) => e.id === r.id && e.event === "execution_finished");
  assert.equal(finished.outcome, "threw");
});

test("crash after execution_started: outcome unknown in the audit, approval never reusable", async () => {
  const r = await approved("synthetic crash mid-execution");
  const code = `const s = await import(${JSON.stringify(storeUrl)}); await s.executeApproved(${JSON.stringify(r.id)}, { action: ${JSON.stringify(r.action)} }, () => process.exit(70));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, encoding: "utf8" });
  assert.equal(p.status, 70);
  const events = auditEvents().filter((e) => e.id === r.id).map((e) => e.event);
  assert.ok(events.includes("execution_started"));
  assert.ok(!events.includes("execution_finished"));
  assert.equal((await store.getRequest(r.id)).effectiveStatus, "consumed");
  assert.equal((await store.consumeApproval(r.id, r.action)).ok, false);
});
