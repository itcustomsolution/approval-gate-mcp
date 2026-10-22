// r6: the MCP registry metadata (server.json) names the package version being built. It had stayed at 0.4.0-rc.2
// while the package moved to 0.4.0-rc.3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("server.json, package.json, package-lock.json and the server's VERSION agree", () => {
  const pkg = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json")), reg = JSON.parse(read("server.json"));
  const version = /const VERSION = "([^"]+)"/.exec(read("src/index.ts"))?.[1];
  assert.deepEqual([lock.version, lock.packages[""].version, reg.version, reg.packages[0].version, version], Array(5).fill(pkg.version));
});
