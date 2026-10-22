// Regressions for the independent review round of 2026-10-16 (OM-01..OM-09). Synthetic state in temp
// dirs only. Races are emulated by patching fs.promises in this test process, never in production code.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, chmodSync, linkSync, promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store, display, dir;
before(async () => {
  store = await import("../dist/store.js");
  display = await import("../dist/display.js");
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-review-"));
  process.env.APPROVAL_GATE_DIR = dir;
  delete process.env.APPROVAL_GATE_MAX_PENDING;
});
const req = (name) => join(dir, "requests", name);
const reqFile = (id) => req(`${id}.json`);
const edit = (id, patch) => writeFileSync(reqFile(id), JSON.stringify({ ...JSON.parse(readFileSync(reqFile(id), "utf8")), ...patch }));
const consumedLines = (id) => readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes(`"consumed"`) && l.includes(id)).length;

test("OM-01: a record moved away while consume claims .used is refused, and stays spent", async () => {
  const r = await store.createRequest("synthetic no-op", "r", 3600);
  await store.decide(r.id, true);
  mkdirSync(join(dir, "archive"), { mode: 0o700 });
  const link = fsp.link;
  fsp.link = async function (from, to, ...rest) {
    if (String(to).endsWith(`${r.id}.used`)) renameSync(reqFile(r.id), join(dir, "archive", `${r.id}.json`)); // archive's first move
    return link.call(this, from, to, ...rest);
  };
  let result;
  try {
    result = await store.consumeApproval(r.id, "synthetic no-op");
  } finally {
    fsp.link = link;
  }
  assert.deepEqual(result, { ok: false, error: "not_usable" });
  assert.equal(consumedLines(r.id), 0);
  renameSync(join(dir, "archive", `${r.id}.json`), reqFile(r.id)); // even if the record comes back
  assert.equal((await store.consumeApproval(r.id, "synthetic no-op")).ok, false);
});

test("OM-01: archive never moves a terminal record whose deadline is still ahead (legacy long TTL)", async () => {
  const r = await store.createRequest("legacy", "r", 3600);
  await store.decide(r.id, true);
  await store.consumeApproval(r.id, "legacy");
  edit(r.id, { createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(await store.archiveRequests(8), 0);
  assert.equal((await store.getRequest(r.id)).effectiveStatus, "consumed");
});

test("OM-03: an unreadable, oversized, empty or directory .final fails closed and returns", async () => {
  const cases = [
    (p) => writeFileSync(p, "x".repeat(300)),
    (p) => writeFileSync(p, ""),
    (p) => mkdirSync(p),
    (p) => { writeFileSync(p, "approved"); chmodSync(p, 0o000); },
  ];
  for (const corrupt of cases) {
    const r = await store.createRequest("a", "r", -1); // already expired: the reader would try to record expiry
    // Replace the expiry marker the create path may already have written.
    const final = req(`${r.id}.final`);
    if (existsSync(final)) renameSync(final, `${final}.old.tmp`);
    corrupt(final);
    const started = Date.now();
    const view = await store.getRequest(r.id);
    assert.ok(Date.now() - started < 2000);
    if (process.getuid?.() !== 0) assert.equal(view.status, "denied");
    assert.equal((await store.consumeApproval(r.id, "a")).ok, false);
  }
});

test("OM-03: an unreadable .used or .committed on an approval reads as unusable", async () => {
  for (const kind of ["used", "committed"]) {
    const r = await store.createRequest("a", "r", 3600);
    await store.decide(r.id, true);
    const p = req(`${r.id}.${kind}`);
    if (existsSync(p)) renameSync(p, `${p}.old.tmp`);
    mkdirSync(p);
    assert.notEqual((await store.getRequest(r.id)).effectiveStatus, "approved_unconsumed");
    assert.equal((await store.consumeApproval(r.id, "a")).ok, false);
  }
});

test("OM-02: creation stops at half the entry cap, and decide/consume/archive keep working", async () => {
  const r = await store.createRequest("a", "r", 3600);
  for (let i = 0; i < 100_000; i++) writeFileSync(req(`filler${i}.tmp`), "");
  await assert.rejects(store.createRequest("b", "r", 3600), /approval-gate archive/);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const s = await import(${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)});
    await s.decide(${JSON.stringify(r.id)}, true);
    const c = await s.consumeApproval(${JSON.stringify(r.id)}, "a");
    console.log(JSON.stringify({ ok: c.ok, archived: await s.archiveRequests(8) }));
  `], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, archived: 0 });
});

test("OM-07: markers orphaned by a crash mid-archive are moved by the next run, never replacing archived files", async () => {
  const r = await store.createRequest("a", "r", 3600);
  await store.decide(r.id, false);
  mkdirSync(join(dir, "archive"), { mode: 0o700 });
  renameSync(reqFile(r.id), join(dir, "archive", `${r.id}.json`)); // crash after the first move
  assert.equal(await store.getRequest(r.id), undefined);
  await store.archiveRequests(8);
  assert.deepEqual(readdirSync(join(dir, "requests")).filter((f) => f.startsWith(r.id)), []);
  assert.equal(readFileSync(join(dir, "archive", `${r.id}.final`), "utf8"), "denied");
  writeFileSync(req(`${r.id}.final`), "approved"); // a later stray marker never overwrites the archived one
  await store.archiveRequests(8);
  assert.equal(readFileSync(join(dir, "archive", `${r.id}.final`), "utf8"), "denied");
});

test("OM-04: invisible and look-alike characters are shown as escapes", () => {
  const hidden = ["\u00ad", "\u00a0", "\u034f", "\u115f", "\u180e", "\u2800", "\u3164", "\ufe0f", "\ufff9", "\u{1d173}", "\u{e0041}", "\u{e007f}", "\u{e0100}", "\ue000", "\ud800", "\u2066", "\u202e", "\u001b", "\u009b"];
  for (const c of hidden) {
    const out = display.safe(`a${c}b`);
    assert.match(out, /^a\\u(\{[0-9a-f]+\}|[0-9a-f]{4})b$/, JSON.stringify(c));
  }
  assert.equal(display.safe("plain text, with spaces: ok"), "plain text, with spaces: ok");
});

test("OM-08: an extreme negative TTL gets the documented error, and nothing is written", async () => {
  await assert.rejects(store.createRequest("a", "r", -1e13), /ttlSeconds/);
  assert.equal(existsSync(join(dir, "requests")) ? readdirSync(join(dir, "requests")).length : 0, 0);
});

test("OM-09: the MCP server's stderr banner escapes the state directory", () => {
  const weird = join(dir, "x\u001b[2J");
  const p = spawnSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], { env: { ...process.env, APPROVAL_GATE_DIR: weird }, input: "", encoding: "utf8", timeout: 5000 });
  assert.match(p.stderr, /ready \(state dir: .*x\\u001b\[2J\)/);
  assert.ok(!p.stderr.includes("\u001b"));
});

test("VF-01: a move interrupted between link and unlink is completed by the next archive run", async () => {
  const r = await store.createRequest("a", "r", 3600);
  await store.decide(r.id, false);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  edit(r.id, { createdAt: old, expiresAt: old });
  mkdirSync(join(dir, "archive"), { mode: 0o700 });
  linkSync(reqFile(r.id), join(dir, "archive", `${r.id}.json`)); // crash after link(), before unlink()
  assert.equal(await store.archiveRequests(8), 1);
  assert.deepEqual(readdirSync(join(dir, "requests")).filter((f) => f.startsWith(r.id)), []);
  assert.deepEqual(readdirSync(join(dir, "archive")).filter((f) => f.startsWith(r.id)).sort(), [`${r.id}.final`, `${r.id}.json`]);
});

test("RV-01: two overlapping archive runs both finish without an error", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  for (let i = 0; i < 20; i++) {
    const r = await store.createRequest(`a${i}`, "r", 3600);
    await store.decide(r.id, false);
    edit(r.id, { createdAt: old, expiresAt: old });
  }
  const runs = await Promise.allSettled([store.archiveRequests(8), store.archiveRequests(8)]);
  assert.deepEqual(runs.map((x) => x.status), ["fulfilled", "fulfilled"], String(runs.map((x) => x.reason)));
  assert.deepEqual(readdirSync(join(dir, "requests")).filter((f) => f.endsWith(".json")), []);
  assert.equal(readdirSync(join(dir, "archive")).filter((f) => f.endsWith(".json")).length, 20);
});
