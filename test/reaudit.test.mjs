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
  // Pause the reader at its first write after the expiry claim, if it makes one, while archive runs.
  const rename = fsp.rename;
  let release;
  const gate = new Promise((res) => { release = res; });
  fsp.rename = async function (a, b, ...rest) {
    if (String(b) === reqFile(r.id) && String(a).endsWith(".tmp")) await gate;
    return rename.call(this, a, b, ...rest);
  };
  try {
    const reader = store.getRequest(r.id);
    await new Promise((res) => setTimeout(res, 50));
    const moved = await store.archiveRequests(8);
    release();
    await reader;
    assert.equal(moved, 1);
  } finally {
    fsp.rename = rename;
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
