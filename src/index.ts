#!/usr/bin/env node
/**
 * approval-gate-mcp
 *
 * A fail-closed human approval gate for AI agent actions, exposed as an MCP server.
 * The gate never executes anything. It records intent, waits for a human decision
 * made out-of-band (via the `approval-gate` CLI), and reports status. Agents are
 * expected to request approval BEFORE performing a consequential action. No status
 * authorizes anything: the only authorization is a successful `consume_approval`
 * (ok:true, once, for the exact approved action), and everything else is a no.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequest, decide, getRequest, listRequestPage, gateDir, consumeApproval, isValidId, LIMITS } from "./store.js";
import { safe } from "./display.js";

const VERSION = "0.4.2";
const server = new McpServer({ name: "approval-gate", version: VERSION });

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

// Character limits here are a client-side hint; the store enforces the byte limits in LIMITS.
const id = z.string().min(1).max(64).describe("The request id returned by request_approval");
const operation = z
  .string()
  .max(LIMITS.operation)
  .optional()
  .describe("Optional operation name a trusted executor must present, e.g. 'smtp.send' (A-Z a-z 0-9 . _ : / -)");
const payload = z
  .unknown()
  .optional()
  .describe(`Optional JSON payload the action will execute (at most ${LIMITS.payloadBytes} bytes canonical). The human reviews it; consume must present an identical payload.`);

server.tool(
  "request_approval",
  "Register a consequential action for human approval BEFORE performing it. Returns a request id. The action is NOT executed by this server; status 'approved' does NOT authorize anything by itself. Right before acting, call consume_approval with the same id, the exact action text and the same operation/payload if you supplied them; proceed only on ok:true. Anything else means no (fail closed).",
  {
    action: z.string().min(1).max(LIMITS.action).describe("Precise description of the action you intend to take, e.g. 'send email to alice@example.com with subject X'"),
    reason: z.string().min(1).max(LIMITS.reason).describe("Why this action is needed right now"),
    requested_by: z.string().max(LIMITS.requestedBy).optional().describe("Identifier of the requesting agent or workflow (self-reported, not authenticated)"),
    ttl_seconds: z.number().int().min(10).max(LIMITS.maxTtlSeconds).default(3600).describe("How long the request stays valid, pending or approved (default 1 hour)"),
    operation,
    payload,
  },
  async ({ action, reason, requested_by, ttl_seconds, operation, payload }) => {
    const req = await createRequest(action, reason, ttl_seconds, requested_by, { operation, payload });
    return text({
      id: req.id,
      status: req.status,
      expiresAt: req.expiresAt,
      payloadDigest: req.payloadDigest,
      note: `A human must run: approval-gate approve ${req.id}  (or: approval-gate deny ${req.id}). Poll with check_approval or block with wait_for_approval. Even after 'approved', do not proceed until consume_approval returns ok:true.`,
    });
  },
);

server.tool(
  "check_approval",
  "Check the current status of an approval request. Informational only: no status here authorizes execution (authorizesExecution is always false). See effectiveStatus (approved_unconsumed, approved_expired, consumed, revoked, ...). Only consume_approval ok:true authorizes.",
  { id },
  async ({ id }) => {
    const req = await getRequest(id);
    if (!req) return text({ error: "not_found", message: "No request with that id" });
    return text(req);
  },
);

server.tool(
  "wait_for_approval",
  "Block until a human decides the request, it expires, or the timeout elapses. Returns the final (or still-pending) request. Informational only; it never authorizes execution. A timeout returns 'pending' (not approved). After 'approved', call consume_approval and proceed only on ok:true.",
  {
    id,
    timeout_seconds: z.number().int().min(1).max(3600).default(300).describe("Maximum time to wait (default 5 minutes)"),
    poll_seconds: z.number().int().min(1).max(60).default(5).describe("Polling interval"),
  },
  async ({ id, timeout_seconds, poll_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    for (;;) {
      const req = await getRequest(id);
      if (!req) return text({ error: "not_found", message: "No request with that id" });
      if (req.status !== "pending") return text({ ...req, note: "Not an authorization. Call consume_approval(id, exact action) and proceed only on ok:true." });
      if (Date.now() >= deadline) return text({ ...req, note: "Timed out while pending. Not approved. Do not proceed." });
      await new Promise((r) => setTimeout(r, Math.min(poll_seconds * 1000, Math.max(0, deadline - Date.now()))));
    }
  },
);

server.tool(
  "list_pending",
  "List approval requests awaiting a human decision, oldest first, one page at a time. Returns {items, nextCursor}; nextCursor is present only when more requests exist (pass it back as cursor). Items omit payload text; use check_approval for one full request.",
  {
    limit: z.number().int().min(1).max(LIMITS.page).default(50).describe(`Page size, 1-${LIMITS.page} (default 50)`),
    cursor: z.string().min(1).max(64).optional().describe("nextCursor from the previous page"),
  },
  async ({ limit, cursor }) => text(await listRequestPage("pending", limit, cursor)),
);

// Approving over MCP lets an agent approve its own request, which defeats the
// gate. By default the MCP tool can only DENY (fail-closed); approvals must come
// from the out-of-band CLI. Set APPROVAL_GATE_ALLOW_MCP_APPROVE=1 only when a
// human is driving the session and you accept that risk.
const allowMcpApprove = process.env.APPROVAL_GATE_ALLOW_MCP_APPROVE === "1";

server.tool(
  "decide_approval",
  allowMcpApprove
    ? "Record a human decision on a pending request. Only for sessions a human is driving; never self-approve. Prefer the CLI: approval-gate approve <id>."
    : "Deny a pending request, or revoke an approved-but-unconsumed one. Approvals are not possible through MCP; a human must run `approval-gate approve <id>` in their own terminal.",
  {
    id,
    approve: z.boolean().describe("true to approve (refused unless enabled by the operator), false to deny"),
    reason: z.string().max(LIMITS.reason).optional().describe("Human's stated reason, verbatim"),
  },
  async ({ id, approve, reason }) => {
    if (approve && !allowMcpApprove) {
      return text({
        error: "approval_via_mcp_disabled",
        message: `Approvals cannot be made through MCP. Ask the human to run: approval-gate approve ${isValidId(id) ? id : "<id>"}`,
      });
    }
    const req = await decide(id, approve, reason);
    return text(req);
  },
);

server.tool(
  "consume_approval",
  "Call this IMMEDIATELY before performing an approved action. Succeeds exactly once per request, only if the request is approved, not past its expiry, `action` is byte-for-byte the text that was approved, and operation/payload (if the request had them) are identical. ok:false for any reason means do NOT proceed. An approval cannot be reused for a second or different action. The returned JSON is not a transferable credential: no other component may accept it as proof of approval.",
  {
    id,
    action: z.string().min(1).max(LIMITS.action).describe("The exact action text you passed to request_approval"),
    operation,
    payload,
  },
  async ({ id, action, operation, payload }) => text(await consumeApproval(id, action, { operation, payload })),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`approval-gate-mcp ${VERSION} ready (state dir: ${safe(gateDir())})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
