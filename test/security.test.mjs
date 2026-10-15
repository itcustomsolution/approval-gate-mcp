// Adversarial regression tests from the 2026-10 security audit. Each test is an exploit
// attempt that must FAIL against the gate.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let store, display, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-sec-"));
  process.env.APPROVAL_GATE_DIR = dir;
  store = await import("../dist/store.js");
  display = await import("../dist/display.js");
});
const reqFile = (id) => join(dir, "requests", `${id}.json`);

test("exploit: agent self-approves via MCP decide_approval -> refused", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { ...process.env, APPROVAL_GATE_DIR: dir };
  delete env.APPROVAL_GATE_ALLOW_MCP_APPROVE;
  const client = new Client({ name: "attacker", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], env }));
  try {
    const r = await client.callTool({ name: "request_approval", arguments: { action: "rm -rf prod", reason: "x" } });
    const { id } = JSON.parse(r.content[0].text);
    const d = await client.callTool({ name: "decide_approval", arguments: { id, approve: true } });
    assert.match(d.content[0].text, /approval_via_mcp_disabled/);
    assert.equal((await store.getRequest(id)).status, "pending");
    const c = await client.callTool({ name: "consume_approval", arguments: { id, action: "rm -rf prod" } });
    assert.equal(JSON.parse(c.content[0].text).ok, false);
  } finally {
    await client.close();
  }
});

test("exploit: agent runs `approval-gate approve <id>` from a non-interactive shell -> refused", async () => {
  const r = await store.createRequest("deploy", "x", 3600);
  const out = spawnSync(process.execPath, [join(root, "dist/cli.js"), "approve", r.id], {
    env: { ...process.env, APPROVAL_GATE_DIR: dir },
    input: r.id.slice(-4) + "\n",
    encoding: "utf8",
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /interactive terminal/);
  assert.equal((await store.getRequest(r.id)).status, "pending");
});

test("exploit: reuse one approval for a different action -> action_mismatch", async () => {
  const r = await store.createRequest("email alice", "x", 3600);
  await store.decide(r.id, true);
  const bad = await store.consumeApproval(r.id, "email everyone");
  assert.deepEqual([bad.ok, bad.error], [false, "action_mismatch"]);
});

test("exploit: replay an approval twice -> second use refused", async () => {
  const r = await store.createRequest("pay invoice 1", "x", 3600);
  await store.decide(r.id, true);
  assert.equal((await store.consumeApproval(r.id, "pay invoice 1")).ok, true);
  const again = await store.consumeApproval(r.id, "pay invoice 1");
  assert.deepEqual([again.ok, again.effectiveStatus], [false, "consumed"]);
});

test("exploit: concurrent replay -> exactly one consumption wins", async () => {
  const r = await store.createRequest("pay invoice 2", "x", 3600);
  await store.decide(r.id, true);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.consumeApproval(r.id, "pay invoice 2")));
  assert.equal(results.filter((x) => x.ok).length, 1);
});

test("denied / pending / expired never consume", async () => {
  const d = await store.createRequest("a", "x", 3600);
  await store.decide(d.id, false);
  assert.equal((await store.consumeApproval(d.id, "a")).ok, false);
  const p = await store.createRequest("b", "x", 3600);
  assert.equal((await store.consumeApproval(p.id, "b")).ok, false);
  const e = await store.createRequest("c", "x", -1);
  assert.equal((await store.consumeApproval(e.id, "c")).ok, false);
});

test("exploit: approval used after the request's expiry -> refused", async () => {
  const r = await store.createRequest("late", "x", 3600);
  await store.decide(r.id, true);
  const j = JSON.parse(readFileSync(reqFile(r.id), "utf8"));
  j.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(reqFile(r.id), JSON.stringify(j));
  assert.equal((await store.consumeApproval(r.id, "late")).effectiveStatus, "approved_expired");
});

test("exploit: race approve vs deny -> exactly one terminal decision", async () => {
  for (let i = 0; i < 10; i++) {
    const r = await store.createRequest("race", "x", 3600);
    const res = await Promise.allSettled([store.decide(r.id, true), store.decide(r.id, false), store.decide(r.id, true)]);
    assert.equal(res.filter((x) => x.status === "fulfilled").length, 1);
    const final = await store.getRequest(r.id);
    const winner = res.find((x) => x.status === "fulfilled").value.status;
    assert.equal(final.status, winner);
  }
});

test("exploit: hand-edit state file to 'approved' -> consume refuses (no decision record)", async () => {
  const r = await store.createRequest("forge", "x", 3600);
  const j = JSON.parse(readFileSync(reqFile(r.id), "utf8"));
  j.status = "approved";
  writeFileSync(reqFile(r.id), JSON.stringify(j));
  assert.equal((await store.consumeApproval(r.id, "forge")).ok, false);
  assert.equal((await store.getRequest(r.id)).status, "denied"); // terminal JSON without a decision record fails closed
});

test("exploit: tampered expiresAt (unparseable) must not mean 'never expires'", async () => {
  const r = await store.createRequest("nan", "x", 3600);
  const j = JSON.parse(readFileSync(reqFile(r.id), "utf8"));
  j.expiresAt = "never";
  writeFileSync(reqFile(r.id), JSON.stringify(j));
  assert.equal((await store.getRequest(r.id)).status, "expired");
});

test("exploit: unknown status / mismatched id in file -> treated as missing", async () => {
  const r = await store.createRequest("odd", "x", 3600);
  const j = JSON.parse(readFileSync(reqFile(r.id), "utf8"));
  writeFileSync(reqFile(r.id), JSON.stringify({ ...j, status: "APPROVED" }));
  assert.equal(await store.getRequest(r.id), undefined);
  const other = await store.createRequest("other", "x", 3600);
  writeFileSync(reqFile(other.id), JSON.stringify(j)); // copy one request onto another id
  assert.equal(await store.getRequest(other.id), undefined);
});

test("ids are 128-bit and non-canonical ids are rejected, not sanitized into a real id", async () => {
  const r = await store.createRequest("id", "x", 3600);
  assert.match(r.id, /^[0-9a-f]{32}$/);
  const dotted = r.id.slice(0, 4) + "." + r.id.slice(4);
  assert.equal(await store.getRequest(dotted), undefined);
  assert.equal(await store.getRequest("../" + r.id), undefined);
  await assert.rejects(store.decide(dotted, false), /No request/);
});

test("state is private to the user (0700 dir, 0600 files)", async (t) => {
  if (process.platform === "win32") return t.skip();
  const r = await store.createRequest("perm", "x", 3600);
  assert.equal(statSync(join(dir, "requests")).mode & 0o077, 0);
  assert.equal(statSync(reqFile(r.id)).mode & 0o077, 0);
});

test("exploit: ANSI/newline/bidi in action cannot spoof the CLI display", () => {
  const s = display.safe("ok\x1b[2K\rapproved: harmless\nreason: fine\u202e");
  assert.doesNotMatch(s, /[\x00-\x1f\u202e]/);
});
