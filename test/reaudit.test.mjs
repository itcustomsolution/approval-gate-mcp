// Regressions for the independent re-audit of 2026-10-17 (RA-AG-01..03). Synthetic state in temp dirs only.
// Crashes and interleavings are emulated in this test process or a child process, never in production code.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store, display, dir;
const storeUrl = new URL("../dist/store.js", import.meta.url).href;
before(async () => {
  store = await import(storeUrl);
  display = await import("../dist/display.js");
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-reaudit-"));
  process.env.APPROVAL_GATE_DIR = dir;
  delete process.env.APPROVAL_GATE_MAX_PENDING;
});
const reqFile = (id) => join(dir, "requests", `${id}.json`);
const events = () => (existsSync(join(dir, "audit.jsonl")) ? readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);

test("RA-AG-01: a process that dies while creating a request never leaves an approvable request without its audit line", () => {
  // Die right after the first file rename of createRequest (the request file in the old order), and
  // separately right after the audit append, to cover both sides of the reordered writes.
  for (const dieAfter of ["rename", "audit"]) {
    const d = mkdtempSync(join(tmpdir(), "approval-gate-crash-"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { promises as fsp } from "node:fs";
      const rename = fsp.rename, open = fsp.open;
      fsp.rename = async function (a, b, ...r) { await rename.call(this, a, b, ...r); if (${JSON.stringify(dieAfter)} === "rename" && String(b).endsWith(".json")) process.exit(71); };
      fsp.open = async function (p, flags, ...r) {
        const fh = await open.call(this, p, flags, ...r);
        if (${JSON.stringify(dieAfter)} === "audit" && String(p).endsWith("audit.jsonl")) { const sync = fh.sync.bind(fh); fh.sync = async () => { await sync(); process.exit(72); }; }
        return fh;
      };
      const s = await import(${JSON.stringify(storeUrl)});
      await s.createRequest("synthetic action", "r", 3600);
    `], { env: { ...process.env, APPROVAL_GATE_DIR: d }, encoding: "utf8", timeout: 10000 });
    assert.ok([0, 71, 72].includes(child.status), child.stderr);
    const ids = existsSync(join(d, "requests")) ? readdirSync(join(d, "requests")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    const requested = existsSync(join(d, "audit.jsonl")) ? readFileSync(join(d, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes('"requested"')) : [];
    // Every request file that exists has its requested line; a requested line may exist without a file.
    for (const id of ids) assert.ok(requested.some((l) => l.includes(id)), `${dieAfter}: request ${id} has no requested audit line`);
    assert.equal(requested.length >= ids.length, true);
  }
});

test("RA-AG-01: a failed requested-audit write creates no request file at all", async () => {
  const open = fsp.open;
  fsp.open = async function (p, flags, ...r) {
    if (String(p).endsWith("audit.jsonl")) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    return open.call(this, p, flags, ...r);
  };
  try {
    await assert.rejects(store.createRequest("a", "r", 3600), /synthetic EIO/);
  } finally {
    fsp.open = open;
  }
  assert.deepEqual(existsSync(join(dir, "requests")) ? readdirSync(join(dir, "requests")).filter((f) => f.endsWith(".json")) : [], []);
});

test("RA-AG-02: a reader expiring a record while archive runs never recreates the archived record", async () => {
  const r = await store.createRequest("old", "r", 3600);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  writeFileSync(reqFile(r.id), JSON.stringify({ ...JSON.parse(readFileSync(reqFile(r.id), "utf8")), createdAt: old, expiresAt: old }));
  // The expiry marker is actually linked before archive runs; no scheduling sleep.
  const link = fsp.link;
  let release, reached, reader;
  const gate = new Promise((resolve) => { release = resolve; });
  const claimed = new Promise((resolve) => { reached = resolve; });
  fsp.link = async function (from, to, ...rest) {
    await link.call(this, from, to, ...rest);
    if (String(to) === join(dir, "requests", `${r.id}.final`)) { reached(); await gate; }
  };
  try {
    reader = store.getRequest(r.id);
    await Promise.race([claimed, reader.then(() => assert.fail("reader finished before expiry-claim barrier"))]);
    assert.equal(readFileSync(join(dir, "requests", `${r.id}.final`), "utf8"), "expired");
    const moved = await store.archiveRequests(8);
    assert.equal(moved, 1);
    assert.equal(existsSync(reqFile(r.id)), false, "archive moved the record while reader was held");
    release();
    await reader;
  } finally {
    release();
    if (reader) await reader.catch(() => {});
    fsp.link = link;
  }
  assert.equal(existsSync(reqFile(r.id)), false, "archived record was recreated in requests/");
  assert.equal(existsSync(join(dir, "archive", `${r.id}.json`)), true);
  assert.equal((await store.consumeApproval(r.id, "old")).ok, false);
  process.env.APPROVAL_GATE_MAX_PENDING = "1";
  await store.createRequest("new", "r", 3600); // the queue is not blocked by a leftover record
});

test("RA-AG-02: a terminal record without its decision marker stops counting against the pending queue", async () => {
  const r = await store.createRequest("orphan", "r", 3600);
  writeFileSync(reqFile(r.id), JSON.stringify({ ...JSON.parse(readFileSync(reqFile(r.id), "utf8")), status: "expired" }));
  assert.equal((await store.getRequest(r.id)).status, "denied"); // terminal JSON with no decision record: fail closed
  process.env.APPROVAL_GATE_MAX_PENDING = "1";
  await store.createRequest("new", "r", 3600);
  assert.equal(readFileSync(join(dir, "requests", `${r.id}.final`), "utf8"), "denied");
});

test("RA-AG-02: expiry is recorded by the marker and the audit log, and reads the same every time", async () => {
  const r = await store.createRequest("short", "r", -1);
  const a = await store.getRequest(r.id);
  const b = await store.getRequest(r.id);
  assert.equal(a.status, "expired");
  assert.equal(a.decidedAt, r.expiresAt);
  assert.deepEqual(a, b);
  assert.equal(JSON.parse(readFileSync(reqFile(r.id), "utf8")).status, "pending"); // the file is not rewritten
  assert.equal(events().filter((e) => e.event === "expired" && e.id === r.id).length, 1);
});

test("RA-AG-03: different text never displays the same", () => {
  const pairs = [["a\u200bb", "a\\u200bb"], ["a\u001bb", "a\\u001bb"], ["a\\b", "a\\\\b"], ["a\u{e0041}b", "a\\u{e0041}b"]];
  for (const [x, y] of pairs) {
    assert.notEqual(x, y);
    assert.notEqual(display.safe(x), display.safe(y), JSON.stringify([x, y]));
  }
  assert.equal(display.safe("C:\\path"), "C:\\\\path");
  assert.equal(display.safeJsonLine(JSON.stringify("a\\b\u200b")), '"a\\\\b\\u200b"');
});

test("RA-AG-03: the CLI shows a real invisible character and its literal escape text differently", async () => {
  const real = await store.createRequest("synthetic\u200btarget", "r", 3600);
  const literal = await store.createRequest("synthetic\\u200btarget", "r", 3600);
  const cli = (...args) => spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, ...args], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, encoding: "utf8" }).stdout;
  const actions = cli("list").split("\n").filter((l) => l.includes("action:"));
  assert.equal(actions.length, 2);
  assert.notEqual(actions[0], actions[1]); // the "action:" line used by list and by the approve prompt
  const shown = (id) => cli("show", id).split("\n").find((l) => l.includes('"action"'));
  assert.notEqual(shown(real.id), shown(literal.id));
  assert.ok(shown(literal.id).includes("\\\\u200b") && !shown(literal.id).includes("\\\\\\\\"), shown(literal.id)); // JSON escape kept once
});

test("OM-R2-AG-01: a late revocation keeps its time in every later view", async () => {
  const r = await store.createRequest("late", "r", 3600);
  await store.decide(r.id, true);
  const past = new Date(Date.now() - 1000).toISOString();
  writeFileSync(reqFile(r.id), JSON.stringify({ ...JSON.parse(readFileSync(reqFile(r.id), "utf8")), expiresAt: past }));
  const revoked = await store.revokeApproval(r.id);
  assert.equal(revoked.effectiveStatus, "revoked");
  assert.equal(JSON.parse(readFileSync(reqFile(r.id), "utf8")).revokedAt, undefined); // the file is not rewritten
  const later = await store.getRequest(r.id);
  assert.equal(later.effectiveStatus, "revoked");
  assert.equal(later.revokedAt, revoked.revokedAt);
  assert.equal(readFileSync(join(dir, "requests", `${r.id}.used`), "utf8"), `revoked ${revoked.revokedAt}`);
});

test("OM-R2-AG-01: a bare revoked marker from an earlier version still reads as revoked", async () => {
  const r = await store.createRequest("old marker", "r", 3600);
  await store.decide(r.id, true);
  writeFileSync(join(dir, "requests", `${r.id}.used`), "revoked");
  const v = await store.getRequest(r.id);
  assert.equal(v.effectiveStatus, "revoked");
  assert.equal(v.revokedAt, undefined);
  assert.equal((await store.consumeApproval(r.id, "old marker")).ok, false);
  writeFileSync(join(dir, "requests", `${r.id}.used`), "revoked 1"); // a loose time is not shown as one
  assert.equal((await store.getRequest(r.id)).revokedAt, undefined);
});
