# approval-gate-mcp

> An MCP server that makes your AI agent stop and ask a human before it sends, deletes, publishes, pays or deploys.

[![npm](https://img.shields.io/npm/v/@itcustomsolution/approval-gate-mcp)](https://www.npmjs.com/package/@itcustomsolution/approval-gate-mcp)
<!-- [![tests](https://github.com/itcustomsolution/approval-gate-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/itcustomsolution/approval-gate-mcp/actions/workflows/test.yml) -->
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why
Agents are good at doing things. The hard part is making sure the consequential things
(sending an email, deleting data, publishing, spending money) only happen when a human
said yes. This server is that gate, extracted from a system I have run in production
for years: after an automation incident taught me the lesson the hard way, my standing
rule became *no automated destructive action without a human gate, ever*. This is the
generic, reusable version of that rule.

## 30-second quickstart

```bash
claude mcp add approval-gate -- npx -y @itcustomsolution/approval-gate-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "approval-gate": {
      "command": "npx",
      "args": ["-y", "@itcustomsolution/approval-gate-mcp"]
    }
  }
}
```

Approve or deny from your terminal with `npx -p @itcustomsolution/approval-gate-mcp approval-gate list`.

## Example

1. Your agent wants to email a customer. It calls `request_approval` with
   `action: "send email to alice@example.com, subject: Invoice 1042"` and gets back id `a1b2c3d4e5f6`.
2. It calls `wait_for_approval`. Nothing is sent.
3. In your own terminal: `approval-gate list`, then `approval-gate approve a1b2c3d4e5f6 looks right`.
4. The agent sees `approved`, calls `consume_approval` with the same id and the exact same action text (single use), and only then sends. Had you denied, ignored it, or let it expire, the answer is no.
5. `~/.approval-gate/audit.jsonl` now has the request and your decision.

## Design principles

- **Fail closed.** The only thing that authorizes an action is a successful consume:
  `consume_approval` returning `ok: true` (once, for the exact approved action), or
  `executeApproved` in trusted code. Pending, approved-but-not-consumed, denied, expired,
  timeout, error: none of those is an authorization; all of them mean **no**.
- **The gate never executes anything.** It records intent and decisions. Your agent asks
  first, then acts only on approval. Separation of decision and execution keeps the gate
  simple and auditable.
- **Decisions are out-of-band.** A human approves or denies with a CLI in their own
  terminal, not inside the agent's context. The MCP tools cannot approve. The CLI asks for an
  interactive terminal and a re-typed confirmation, which is a speed bump, **not authentication**:
  anything running as your OS user (a shell, a PTY, or file access) can still get past it. See
  [Threat model](#threat-model).
- **Only a consume authorizes.** `status: "approved"` is informational. Status responses
  carry `authorizesExecution: false` and an `effectiveStatus` (`approved_unconsumed`,
  `approved_expired`, `consumed`, `revoked`, ...). Trusted code that performs the side effect
  should call `executeApproved` (see [Trusted execution boundary](#trusted-execution-boundary)),
  which consumes the approval itself. A consume result that arrived over MCP, from a file or from
  an agent is never proof of approval, however well-formed.
- **Everything is audited.** Every request, decision, expiry, and consumption is appended to
  `~/.approval-gate/audit.jsonl` (an append-only convention, not a tamper-proof log).
- **Requests expire.** Default TTL is 1 hour; a stale approval is not an approval.
- **Approvals are single-use and bound to the action.** `consume_approval` succeeds once, only for
  the exact action text that was approved (and, if the request carried them, the same operation
  name and the same canonical JSON payload), and only if the clock read after all of its
  persistence is still at or before the request's expiry.

## Install

Requires Node.js 22 or later (Node 18 and 20 are past end of life; the MCP SDK's `@hono/node-server`
dependency needs Node 20+).

From npm:

```bash
npm install -g @itcustomsolution/approval-gate-mcp   # installs `approval-gate` and `approval-gate-mcp`
```

From source:

```bash
npm install
npm run build
npm link        # makes `approval-gate` and `approval-gate-mcp` available on PATH
```


## Wire it into an MCP client

Claude Code:

```bash
claude mcp add approval-gate -- node /path/to/approval-gate-mcp/dist/index.js
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "approval-gate": {
      "command": "node",
      "args": ["/path/to/approval-gate-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `request_approval` | Register an intended action (`action`, `reason`, optional `ttl_seconds`, optional `operation` and JSON `payload` to bind). Returns an id (and `payloadDigest`). |
| `check_approval` | Poll a request's status: `pending` / `approved` / `denied` / `expired`. |
| `wait_for_approval` | Block up to `timeout_seconds` for a decision. Timeout = still pending = **not approved**. |
| `list_pending` | List requests awaiting a human, oldest first, one page at a time (`limit` 1-100, default 50; pass `nextCursor` back as `cursor`). |
| `consume_approval` | Call right before acting. Succeeds **once**, only if approved, unexpired, and `action` (plus `operation`/`payload`, if the request had them) matches exactly. Anything else: do not proceed. Its JSON result is not a transferable credential. |
| `decide_approval` | Deny a pending request, or revoke an approved one that has not been consumed. Approving through MCP is refused by default, so an agent cannot approve its own request; approvals come from the CLI. Operators can opt in with `APPROVAL_GATE_ALLOW_MCP_APPROVE=1` (not recommended). |

## The human side

```bash
approval-gate list                # pending requests
approval-gate show a1b2c3d4e5f6
approval-gate approve a1b2c3d4e5f6 looks right, ship it
approval-gate deny a1b2c3d4e5f6 wrong recipient
approval-gate revoke a1b2c3d4e5f6 changed my mind   # approved but not yet consumed
approval-gate list approved --limit 20 --after a1b2c3d4e5f6   # page through history
approval-gate archive --older-than-days 30          # retention: move finished requests aside
```

`show` and the `approve` confirmation print the operation and the full canonical payload (escaped)
when a request binds one: that is exactly what an executor will be allowed to run.

## Suggested agent policy

Put something like this in your agent's system prompt or policy file:

> Before any outbound or destructive action (send, publish, delete, purchase, deploy),
> call `request_approval` and then `wait_for_approval`. When it returns `approved`, call
> `consume_approval` with the same id and exact action text, and proceed only if it returns
> `ok: true`. Never call `decide_approval` for your own requests.

## Trusted execution boundary

When your own code (not the agent) performs the side effect, let the gate consume the approval at
that boundary and run exactly the approved payload:

```js
import { executeApproved } from "@itcustomsolution/approval-gate-mcp/dist/store.js";

// id comes from the agent; the action, operation and payload are what your code is about to run.
await executeApproved(id, { action, operation: "smtp.send", payload: { to, subject, body } }, async (ctx) => {
  ctx.assertActive();          // re-check expiry immediately before the side effect
  await smtp.send(ctx.payload); // ctx.payload is a frozen copy of what the human approved
});
```

`executeApproved` accepts no receipt. It performs the single-use consume itself (binding to the
action text, and to the operation and payload if the request carried them), writes an
`execution_started` audit line (fsync), checks expiry again, and only then calls your function. If
the start record cannot be written, or the approval expired during that write, nothing runs. Call
`ctx.assertActive()` again after any `await` that precedes the side effect.

`assertConsumed(result, id, action, binding?)` remains for code that calls `consumeApproval`
itself: it accepts only a grant object issued by `consumeApproval` **in the same process**, once,
for the same id/action/binding, before expiry. A copy, a JSON round trip (an MCP response, a file,
an agent message) or a hand-built object is always refused. 0.3.0 accepted any well-shaped object;
see the changelog.

**Crash and replay semantics.** Consumption is at-most-once: once `.used` is claimed the approval is
spent, whatever happens next, including refusals after the claim (expired during persistence, audit
failure). A crash after `execution_started` and before `execution_finished` means the outcome is
unknown: inspect the external system and, if needed, create and approve a new request. Nothing is
retried automatically, and there is no atomic guarantee between this gate's files and the external
system your callback touches. Details: [docs/authorization-states.md](docs/authorization-states.md).

## Limits

| Limit | Value |
|---|---|
| `action`, `reason`, decision reason | 8192 UTF-8 bytes each |
| `requested_by` | 256 bytes (self-reported, never authenticated) |
| `operation` | 1-128 of `A-Z a-z 0-9 . _ : / -` |
| `payload` | JSON only; 32 KiB canonical (RFC 8785), depth 32, 10000 values |
| TTL | MCP: integer 10 s to 7 days; library: any finite number up to 7 days (zero or negative gives an already-expired request) |
| Requests awaiting a decision | `APPROVAL_GATE_MAX_PENDING`, default 100, 1 to 10000. Concurrent creators can overshoot by at most their own number. Invalid values fail closed. |
| List page | 1-100 (default 50) |

When the queue is full, `request_approval` fails with `approval queue full` until a human decides
requests or they expire. Finished requests stay on disk until you run `approval-gate archive`
(minimum age 8 days, more than the 7-day TTL cap, so nothing archived can still be used).

## State

Everything lives in `~/.approval-gate/` (override with `APPROVAL_GATE_DIR`):
`requests/*.json` for current state, `requests/*.final` / `*.used` one-time decision and
consumption markers, `audit.jsonl` for the history and `archive/` for archived requests. The
directory is created `0700` and files `0600`.

**Privacy:** action text, reasons, `requested_by` and any bound payload are stored in plain text in
these files, and action text and reasons are copied into `audit.jsonl`. Do not put credentials or
secrets in them.

## Threat model

What the gate does protect against:

- An agent that can only reach this server over MCP approving its own request (MCP cannot approve).
- An agent driving the CLI from a non-interactive shell (`approve` requires a TTY plus a typed confirmation).
- Reusing one approval for a second or different action (`consume_approval` is single-use and action-bound).
- Using an approval after the request's expiry, races between approve/deny/expiry, guessed ids
  (128-bit random), malformed or hand-edited state files without a matching decision record, and
  terminal escape sequences in request text that try to disguise what you are approving.

What it does **not** protect against:

- **Trust limitation, not a bug that has been fixed: an agent with a shell, a PTY, or file access as your OS user.** It can drive a pseudo-terminal, edit
  `~/.approval-gate/`, or simply skip the gate and perform the action. The gate is a cooperation
  protocol plus an audit trail, not a sandbox. For hard enforcement, run the agent as a separate
  OS user (or in a container) that cannot read or write the gate directory, and keep the gate's
  CLI for yourself.
- **The actual payload.** `consume_approval` matches the action *text*. It cannot prove that the email,
  SQL, or deploy the agent then runs equals what you read. That binding is cooperative. See
  [docs/design-trusted-executor.md](docs/design-trusted-executor.md) for an enforced design (proposal only).
- **Unattended, consequential use.** Without OS-level separation (see above), do not treat this gate as
  the only control for unattended agents doing irreversible things. Keep those paths fail-closed, with
  no automatic execution.
- An agent that never calls the gate. Enforcement of *asking* is up to your agent's policy and tooling.
- Tampering with `audit.jsonl` by anyone with write access to it.

`executeApproved` and payload binding are local safeguards: they make the executed payload equal
the approved one *when your trusted code uses them*. They do not authenticate the human or stop a
same-user agent from bypassing the gate. A separately trusted authority/executor would still need:

1. The executor running as a different OS user, container or service account that the agent
   cannot control, holding the only credential for the side effect.
2. A gate state directory the agent's user cannot read or write.
3. Human approval made with a credential the agent does not have (for example a hardware-key
   signature or an OS prompt for another user), not a TTY.
4. The agent asking the executor to run an approved id by reference, never sending the payload
   again.
5. A tamper-evident (hash-chained or off-host) audit log.

None of that is created by this package; it needs an owner decision and new credentials. See
[docs/design-trusted-executor.md](docs/design-trusted-executor.md).

Setting `APPROVAL_GATE_ALLOW_MCP_APPROVE=1` re-enables approval over MCP and removes the main
protection. Only use it when a human is the only one driving the MCP client.

State transitions, revocation, and crash behavior are specified in
[docs/authorization-states.md](docs/authorization-states.md). `approval-gate revoke <id>` (or `deny`
on an approved request) cancels an approval that has not been consumed yet.

## Why so small?

Because the pattern matters more than the plumbing. In my production systems this same
shape (request, out-of-band human decision, fail-closed default, audit trail) sits in
front of email, publishing, and deployments, and it has removed entire classes of
automation incidents. Start small, gate the scary
things, and let your incident postmortems tell you what to gate next.

## Contributing

Issues and pull requests are welcome. Keep changes small and fail-closed: anything that
could turn a "no" into a "yes" needs a test. Run `npm test` before opening a PR.
See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT, see [LICENSE](LICENSE).

---

Built by [Olufela "Lu" Fagbure](https://www.linkedin.com/in/olufelafagbure) ·
[itcustomsolution.com](https://itcustomsolution.com) · MIT license
