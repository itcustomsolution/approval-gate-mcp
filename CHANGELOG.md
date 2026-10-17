# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic versioning.

## [Unreleased]

## [0.4.0-rc.1] - unreleased candidate (2026-10-16, not published)

**Breaking:** `assertConsumed` no longer accepts arbitrary well-shaped objects; Node 22 or later is required;
`list_pending` returns `{items, nextCursor}`; request text, payload and queue limits are enforced; library TTLs over
7 days are refused.

### Security (2026-10-16 audit: AG-01 to AG-05)
- AG-01: `assertConsumed(result, id, action, binding?)` accepts only a grant object issued by `consumeApproval` in the
  same process, once, before expiry. JSON copies (MCP responses, files, agent messages) and hand-built objects are
  refused. New `executeApproved(id, {action, operation?, payload?}, fn)` performs the single-use consume itself and
  passes the function a frozen copy of the approved payload.
- Payload binding: requests may carry an `operation` name and a JSON `payload` (RFC 8785 canonical form, SHA-256).
  Consume must present the same binding; the CLI shows both to the human.
- AG-02: expiry is checked again after all awaited persistence, and by `executeApproved` immediately before the
  function runs (after an fsynced `execution_started` audit record). Refusals after the claim keep the approval spent.
  Crash and replay semantics are documented in docs/authorization-states.md.
- AG-03: README and source no longer say an `approved` status authorizes; a documentation regression test guards it.
- AG-04: every CLI error is escaped for the terminal; invalid ids are rejected without being echoed.
- AG-05: UTF-8 byte limits for action/reason/requested_by/operation/payload; a pending-queue cap
  (`APPROVAL_GATE_MAX_PENDING`, default 100); paginated `list_pending` and `approval-gate list --limit/--after`;
  `approval-gate archive` for retention. `listRequests` keeps returning every match (0.x behavior).
- Dependencies: MCP SDK 1.32.1 (outside the four SDK 1.31.0 vendor advisory ranges), Hono floor 4.13.13 (outside
  GHSA-5r4p-p66f-jhc7); lock refreshed to current in-range versions.
- CI: actions pinned to commit SHAs; Node 22/24/26 matrix; dependency lifecycle scripts disabled.

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
