# approval-gate-mcp

**Fail-closed human approval gates for AI agent actions, as an MCP server.**

Agents are good at doing things. The hard part is making sure the consequential things
(sending an email, deleting data, publishing, spending money) only happen when a human
said yes. This server is that gate, extracted from a system I have run in production
for years: after an automation incident taught me the lesson the hard way, my standing
rule became *no automated destructive action without a human gate, ever*. This is the
generic, reusable version of that rule.

## Design principles

- **Fail closed.** The only thing that authorizes an action is an explicit `approved`.
  Pending, denied, expired, timeout, error: all of those mean **no**.
- **The gate never executes anything.** It records intent and decisions. Your agent asks
  first, then acts only on approval. Separation of decision and execution keeps the gate
  simple and auditable.
- **Decisions are out-of-band.** A human approves or denies with a CLI in their own
  terminal, not inside the agent's context, so the agent cannot talk itself through the gate.
- **Everything is audited.** Every request, decision, and expiry is appended to
  `~/.approval-gate/audit.jsonl`.
- **Requests expire.** Default TTL is 1 hour; a stale approval is not an approval.

## Install

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
| `request_approval` | Register an intended action (`action`, `reason`, optional `ttl_seconds`). Returns an id. |
| `check_approval` | Poll a request's status: `pending` / `approved` / `denied` / `expired`. |
| `wait_for_approval` | Block up to `timeout_seconds` for a decision. Timeout = still pending = **not approved**. |
| `list_pending` | List requests awaiting a human. |
| `decide_approval` | Record a decision when the human is driving the session. Agents must never self-approve; prefer the CLI. |

## The human side

```bash
approval-gate list                # pending requests
approval-gate show a1b2c3d4e5f6
approval-gate approve a1b2c3d4e5f6 looks right, ship it
approval-gate deny a1b2c3d4e5f6 wrong recipient
```

## Suggested agent policy

Put something like this in your agent's system prompt or policy file:

> Before any outbound or destructive action (send, publish, delete, purchase, deploy),
> call `request_approval` and then `wait_for_approval`. Proceed only if the returned
> status is exactly `approved`. Never call `decide_approval` for your own requests.

## State

Everything lives in `~/.approval-gate/` (override with `APPROVAL_GATE_DIR`):
`requests/*.json` for current state, `audit.jsonl` for the append-only history.

## Why so small?

Because the pattern matters more than the plumbing. In my production systems this same
shape (request, out-of-band human decision, fail-closed default, audit trail) sits in
front of email, publishing, and deployments, and it has turned entire classes of
automation incidents into structural impossibilities. Start small, gate the scary
things, and let your incident postmortems tell you what to gate next.

---

Built by [Olufela "Lu" Fagbure](https://www.linkedin.com/in/olufelafagbure) ·
[itcustomsolution.com](https://itcustomsolution.com) · MIT license
