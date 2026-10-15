# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic versioning.

## [Unreleased]

## [0.3.0] - 2026-10-15

### Security (follow-ups to the #24 review threads and an independent audit)
- Status responses never authorize: `authorizesExecution: false` and `effectiveStatus`. Tool texts no
  longer say that `approved` authorizes. Added an `assertConsumed()` helper for execution boundaries.
- Upgrade: existing permissive state dirs, request files and `audit.jsonl` are chmodded to 0700/0600.
  Symlinked or foreign-owned paths are refused.
- Markers are created complete (fsynced temp file plus link(2)). An approval is consumable only after
  its record and audit are persisted (`.committed`). Write or audit failures invalidate it.
- Expiry is decided at claim time for approvals and re-checked after the use claim. Revocation is added
  (`approval-gate revoke`, or deny on an approved request).
- Escaping now covers U+061C, U+200B–U+200F, U+2060–U+2069 and U+FEFF.
- Docs: authorization state machine, trust limitations, trusted-executor design proposal.

## [0.2.0] - 2026-10-15

**Breaking:** scripted approvals no longer work. `approval-gate approve` now requires an interactive
terminal with a typed confirmation, and agents must call `consume_approval(id, action)` (single-use,
bound to the exact approved action) before acting instead of relying on an `approved` status alone.

### Security (from the 2026-10 adversarial audit)
- New `consume_approval(id, action)` tool: single-use, bound to the exact approved action text,
  refused after the request's expiry. Previously one `approved` id could be reused for any number of
  different actions, forever.
- CLI `approve` now requires an interactive terminal and a typed confirmation, so an agent cannot
  approve by shelling out to `approval-gate approve <id>`. (Breaking for scripted approvals.)
- Exactly one terminal transition wins under concurrency (approve vs deny vs expiry race).
- Unparseable `expiresAt` is treated as expired instead of never expiring.
- State files are strictly validated (status enum, id must match file name); hand-edited `approved`
  files without a decision record cannot be consumed.
- Request ids are 128-bit; non-canonical ids are rejected instead of being sanitized into another id.
- State directory `0700`, files `0600`; atomic writes.
- CLI neutralizes ANSI/control/bidi characters in request text.
- README: threat model section; removed the claim that the agent "cannot talk itself through the gate".

## [0.1.1]

### Security
- `decide_approval` over MCP can only deny by default; approvals come from the CLI
  (`APPROVAL_GATE_ALLOW_MCP_APPROVE=1` to opt back in). Reported by @Kantorcodes.

## [Pre-0.1.1 notes]

### Added
- Package metadata for npm publishing (`repository`, `homepage`, `bugs`, `engines`, `mcpName`, keywords).
- Behavior tests for the approval store (`npm test`, uses built-in `node:test`, no new dependencies).
- One light CI job on pull requests.
- README quickstart, example flow, contributing section.

No runtime behavior changes.

## [0.1.0]

### Added
- Initial MCP server with `request_approval`, `check_approval`, `wait_for_approval`,
  `list_pending`, `decide_approval`.
- `approval-gate` CLI for out-of-band human decisions.
- Default-deny, TTL expiry, append-only audit log in `~/.approval-gate/`.
