// Regressions found while the r2 candidate was under independent audit (2026-10-17). Synthetic state in temp dirs
// only; the interleaving is emulated in a child process, never in production code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeUrl = new URL("../dist/store.js", import.meta.url).href;

// PREP-AG-ARCHIVE-RACE: two archive runs at once crashed one of them with ENOENT, because the start-up permission
// sweep listed a file that the other run moved before it could be checked. A file that disappears between listing
// and lstat, or between lstat and chmod, is skipped; anything else (a symlink, another owner) still refuses.
for (const vanishAt of ["lstat", "chmod"]) {
  test(`PREP-AG-ARCHIVE-RACE: a state file that disappears before its ${vanishAt} does not crash the sweep`, () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-gate-race-"));
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const s = await import(${JSON.stringify(storeUrl)});
      for (let i = 0; i < 3; i++) { const r = await s.createRequest("synthetic action " + i, "r", 3600); await s.decide(r.id, false); }
    `], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, encoding: "utf8", timeout: 10000 });
    assert.equal(setup.status, 0, setup.stderr);
    // Loose modes, as left by an older version, so the sweep also reaches chmod.
    for (const f of readdirSync(join(dir, "requests"))) chmodSync(join(dir, "requests", f), 0o644);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { promises as fsp } from "node:fs";
      const real = fsp[${JSON.stringify(vanishAt)}];
      let gone = 0;
      fsp[${JSON.stringify(vanishAt)}] = async function (p, ...r) {
        if (gone < 2 && /requests[\\\\/][0-9a-f]+\\.(json|final)$/.test(String(p))) { gone++; await fsp.unlink(p); }
        return real.call(this, p, ...r);
      };
      const s = await import(${JSON.stringify(storeUrl)});
      console.log(JSON.stringify({ archived: await s.archiveRequests(8), pending: (await s.listRequests("pending")).length, gone }));
    `], { env: { ...process.env, APPROVAL_GATE_DIR: dir }, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split("\n").pop());
    assert.equal(out.gone, 2);
    assert.equal(out.pending, 0);
  });
}
