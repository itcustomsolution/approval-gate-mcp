// AG-03 documentation contract, AG-04 terminal-safe CLI errors, MCP-level bounds and binding.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let store, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-gate-contract-"));
  process.env.APPROVAL_GATE_DIR = dir;
  store = await import("../dist/store.js");
});

test("AG-03: no shipped instruction says an 'approved' status authorizes; consume is the only authorization", () => {
  // CHANGELOG is release history (it quotes the old wording), so it is not scanned.
  const files = ["README.md", "src/index.ts", "src/store.ts", "src/cli.ts", ...readdirSync(join(root, "docs")).map((f) => `docs/${f}`)];
  const offenders = [];
  for (const f of files) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
      const prose = line.replace(/authorizesExecution/g, "");
      if (/approved/i.test(prose) && /authori[sz]/i.test(prose) && !/\b(not|never|no|only|consume|executeApproved|informational|nothing)\b/i.test(prose)) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /only thing that authorizes an action is an explicit `approved`/);
  assert.match(readme, /only thing that authorizes an action is a successful consume/i);
  assert.doesNotMatch(readFileSync(join(root, "src/index.ts"), "utf8"), /treat anything other than an explicit "approved" as a no/);
});

function cli(args, input = "") {
  return spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, input, encoding: "utf8" });
}
const rawControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

test("AG-04: CLI output never carries raw terminal controls from arguments, including error paths", async () => {
  const hostile = "invalid\u001b[2Jfixture\r\u202e";
  const r = await store.createRequest("synthetic ESC fixture \u001b[2J", "fixture only", 3600, "agent\u001b]0;title\u0007");
  for (const args of [["show", hostile], ["deny", hostile], ["revoke", hostile], ["approve", hostile], ["list", "--after", hostile], ["list"], ["show", r.id], ["revoke", r.id], ["bogus\u001b[2J"]]) {
    const p = cli(args);
    assert.doesNotMatch(p.stdout + p.stderr, rawControls, JSON.stringify(args));
  }
  const deny = cli(["deny", hostile]);
  assert.equal(deny.status, 2);
  assert.match(deny.stderr, /invalid request id/);
  assert.equal((await store.getRequest(r.id)).status, "pending");
});

test("CLI: list pages with --limit/--after, archive enforces its minimum age, approve still needs a TTY", async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await store.createRequest(`cli page ${i}`, "r", 3600)).id);
  const first = cli(["list", "pending", "--limit", "1"]);
  assert.equal(first.status, 0);
  const next = first.stdout.match(/--after ([0-9a-f]+)/)[1];
  assert.equal(cli(["list", "pending", "--limit", "1", "--after", next]).status, 0);
  const bad = cli(["archive", "--older-than-days", "7"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /olderThanDays must be an integer from 8/);
  assert.equal(cli(["archive"]).status, 0);
  const approve = cli(["approve", ids[0]], ids[0].slice(-4) + "\n");
  assert.equal(approve.status, 2);
  assert.match(approve.stderr, /interactive terminal/);
  assert.equal((await store.getRequest(ids[0])).status, "pending");
});

test("MCP: bounds, payload binding and paginated list_pending over stdio", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const mdir = mkdtempSync(join(tmpdir(), "approval-gate-mcp-"));
  const env = { ...process.env, APPROVAL_GATE_DIR: mdir };
  delete env.APPROVAL_GATE_ALLOW_MCP_APPROVE;
  const client = new Client({ name: "synthetic-agent", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], env, stderr: "ignore" }));
  const call = (name, args) => client.callTool({ name, arguments: args });
  const parse = (r) => JSON.parse(r.content[0].text);
  try {
    assert.equal((await call("request_approval", { action: "x".repeat(8193), reason: "r" })).isError, true);
    assert.equal((await call("request_approval", { action: "a", reason: "r", ttl_seconds: 9 })).isError, true);
    assert.equal((await call("request_approval", { action: "a", reason: "r", payload: { s: "\ud800" } })).isError, true); // lone surrogate: not I-JSON
    const payload = { to: "alice@example.invalid", amount: 5 };
    const req = parse(await call("request_approval", { action: "synthetic payment", reason: "r", operation: "payments.send", payload }));
    assert.match(req.payloadDigest, /^[0-9a-f]{64}$/);
    const view = parse(await call("check_approval", { id: req.id }));
    assert.equal(view.payloadCanonical, '{"amount":5,"to":"alice@example.invalid"}');
    process.env.APPROVAL_GATE_DIR = mdir;
    await store.decide(req.id, true);
    process.env.APPROVAL_GATE_DIR = dir;
    const wrong = parse(await call("consume_approval", { id: req.id, action: "synthetic payment", operation: "payments.send", payload: { ...payload, amount: 500 } }));
    assert.deepEqual([wrong.ok, wrong.error], [false, "payload_mismatch"]);
    const right = parse(await call("consume_approval", { id: req.id, action: "synthetic payment", operation: "payments.send", payload }));
    assert.equal(right.ok, true);
    for (let i = 0; i < 3; i++) await call("request_approval", { action: `pending ${i}`, reason: "r" });
    const page1 = parse(await call("list_pending", { limit: 2 }));
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = parse(await call("list_pending", { limit: 2, cursor: page1.nextCursor }));
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, undefined);
    assert.equal((await call("list_pending", { limit: 101 })).isError, true);
    const self = parse(await call("decide_approval", { id: page2.items[0].id, approve: true }));
    assert.equal(self.error, "approval_via_mcp_disabled");
  } finally {
    await client.close();
  }
});
