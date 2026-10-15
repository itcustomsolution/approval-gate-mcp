// Regression tests for the five #24 review threads and the independent audit (items a-g).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store, display, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-rf-"));
  // (d) simulate a pre-0.2 state dir with permissive modes
  mkdirSync(join(dir, "requests"), { recursive: true });
  writeFileSync(join(dir, "audit.jsonl"), "");
  writeFileSync(join(dir, "requests", "aaaaaaaaaaaa.json"), "{}");
  chmodSync(dir, 0o755); chmodSync(join(dir, "requests"), 0o755);
  chmodSync(join(dir, "audit.jsonl"), 0o644); chmodSync(join(dir, "requests", "aaaaaaaaaaaa.json"), 0o644);
  process.env.APPROVAL_GATE_DIR = dir;
  store = await import("../dist/store.js");
  display = await import("../dist/display.js");
});
const p = (id, ext) => join(dir, "requests", `${id}.${ext}`);

test("(d) upgrade: permissive dir, requests dir, audit file and old request files are tightened", async (t) => {
  if (process.platform === "win32") return t.skip();
  await store.listRequests();
  for (const f of [dir, join(dir, "requests"), join(dir, "audit.jsonl"), join(dir, "requests", "aaaaaaaaaaaa.json")])
    assert.equal(statSync(f).mode & 0o077, 0, f);
});

test("(a) status views never authorize; consumed/expired approvals do not look usable", async () => {
  const r = await store.createRequest("act", "x", 3600);
  await store.decide(r.id, true);
  let v = await store.getRequest(r.id);
  assert.equal(v.authorizesExecution, false);
  assert.equal(v.effectiveStatus, "approved_unconsumed");
  assert.equal((await store.consumeApproval(r.id, "act")).ok, true);
  v = await store.getRequest(r.id);
  assert.equal(v.effectiveStatus, "consumed");
  assert.equal(v.authorizesExecution, false);
});

test("(a) assertConsumed accepts only a genuine consume result for this id and action", async () => {
  const r = await store.createRequest("pay 1", "x", 3600);
  await store.decide(r.id, true);
  const view = await store.getRequest(r.id);
  assert.throws(() => store.assertConsumed(view, r.id, "pay 1")); // a status view is not a grant
  assert.throws(() => store.assertConsumed({ ok: true, id: r.id, action: "pay 1" }, r.id, "pay 1")); // forged/partial
  const c = await store.consumeApproval(r.id, "pay 1");
  store.assertConsumed(c, r.id, "pay 1");
  assert.throws(() => store.assertConsumed(c, r.id, "pay 2"));
});

test("(a) MCP tool descriptions no longer say 'approved' authorizes", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Only 'approved' authorizes/);
  assert.doesNotMatch(src, /only proceed on an explicit 'approved'/);
});

test("(e) approval that would win after the deadline is recorded expired", async () => {
  const r = await store.createRequest("late", "x", 3600);
  const j = JSON.parse(readFileSync(p(r.id, "json"), "utf8"));
  // pending + already past deadline but not yet swept: decide sees it via reconcile -> expired
  j.expiresAt = new Date(Date.now() - 1).toISOString();
  writeFileSync(p(r.id, "json"), JSON.stringify(j));
  await assert.rejects(store.decide(r.id, true), /expired/);
  assert.equal(readFileSync(p(r.id, "final"), "utf8"), "expired");
});

test("(e) expiry is evaluated after the exclusive use claim (check-vs-use)", async () => {
  const r = await store.createRequest("edge", "x", 3600);
  await store.decide(r.id, true);
  // Expire between the eligibility check and the claim by making expiresAt 'now'
  const j = JSON.parse(readFileSync(p(r.id, "json"), "utf8"));
  j.expiresAt = new Date(Date.now() + 15).toISOString();
  writeFileSync(p(r.id, "json"), JSON.stringify(j));
  await new Promise((res) => setTimeout(res, 30));
  const c = await store.consumeApproval(r.id, "edge");
  assert.equal(c.ok, false);
});

test("(e) revocation: revoke beats later consume; consume beats later revoke; exactly one wins concurrently", async () => {
  const a = await store.createRequest("r1", "x", 3600);
  await store.decide(a.id, true);
  assert.equal((await store.revokeApproval(a.id)).effectiveStatus, "revoked");
  assert.equal((await store.consumeApproval(a.id, "r1")).ok, false);
  const b = await store.createRequest("r2", "x", 3600);
  await store.decide(b.id, true);
  assert.equal((await store.consumeApproval(b.id, "r2")).ok, true);
  await assert.rejects(store.revokeApproval(b.id), /consumed/);
  const c = await store.createRequest("r3", "x", 3600);
  await store.decide(c.id, true);
  const res = await Promise.allSettled([store.consumeApproval(c.id, "r3"), store.revokeApproval(c.id)]);
  const consumed = res[0].status === "fulfilled" && res[0].value.ok;
  const revoked = res[1].status === "fulfilled";
  assert.equal(Number(consumed) + Number(revoked), 1);
});

test("(f) audit write failure during approval leaves it unusable", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip();
  const r = await store.createRequest("aud", "x", 3600);
  chmodSync(join(dir, "audit.jsonl"), 0o400); // synthetic, bounded: make appends fail
  try {
    await assert.rejects(store.decide(r.id, true));
  } finally {
    chmodSync(join(dir, "audit.jsonl"), 0o600);
  }
  assert.equal((await store.consumeApproval(r.id, "aud")).ok, false);
  assert.equal((await store.getRequest(r.id)).effectiveStatus, "invalidated");
});

test("(f) crash after final marker but before commit: approval is never usable", async () => {
  const r = await store.createRequest("crash", "x", 3600);
  writeFileSync(p(r.id, "final"), "approved"); // simulate crash right after the marker
  const v = await store.getRequest(r.id);
  assert.equal(v.status, "approved");
  assert.equal(v.effectiveStatus, "approved_uncommitted");
  assert.equal((await store.consumeApproval(r.id, "crash")).ok, false);
});

test("(f) crash after deny marker: request reads denied even though JSON says pending", async () => {
  const r = await store.createRequest("crash2", "x", 3600);
  writeFileSync(p(r.id, "final"), "denied");
  assert.equal((await store.getRequest(r.id)).status, "denied");
});

test("(f) markers are never left empty or temp files lingering after a decision", async () => {
  const r = await store.createRequest("m", "x", 3600);
  await store.decide(r.id, true);
  assert.equal(readFileSync(p(r.id, "final"), "utf8"), "approved");
  assert.equal(readFileSync(p(r.id, "committed"), "utf8"), "committed");
  assert.ok(!readdirSync(join(dir, "requests")).some((f) => f.endsWith(".tmp")));
});

test("(f) audit failure during consume burns the approval and refuses", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip();
  const r = await store.createRequest("ca", "x", 3600);
  await store.decide(r.id, true);
  chmodSync(join(dir, "audit.jsonl"), 0o400);
  let c;
  try { c = await store.consumeApproval(r.id, "ca"); } finally { chmodSync(join(dir, "audit.jsonl"), 0o600); }
  assert.deepEqual([c.ok, c.error], [false, "audit_failed"]);
  assert.equal((await store.consumeApproval(r.id, "ca")).ok, false);
});

test("(d) symlinked audit file is refused", async (t) => {
  if (process.platform === "win32") return t.skip();
  const d2 = mkdtempSync(join(tmpdir(), "approval-gate-ln-"));
  mkdirSync(join(d2, "requests"), { mode: 0o700 });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(d2, "elsewhere"), join(d2, "audit.jsonl"));
  const prev = process.env.APPROVAL_GATE_DIR;
  process.env.APPROVAL_GATE_DIR = d2;
  try {
    await assert.rejects(store.createRequest("x", "y", 60), /symlink/);
  } finally {
    process.env.APPROVAL_GATE_DIR = prev;
  }
  assert.equal(existsSync(join(d2, "elsewhere")), false);
});

test("(g) bidi/directional and zero-width controls are escaped", () => {
  for (const c of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c", "\u200b", "\ufeff", "\x1b", "\r", "\n"]) {
    const out = display.safe(`a${c}b`);
    assert.ok(!out.includes(c), JSON.stringify(c));
    assert.match(out, /\\u[0-9a-f]{4}/);
  }
});
