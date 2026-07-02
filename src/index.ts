#!/usr/bin/env node
/**
 * approval-gate-mcp
 *
 * A fail-closed human approval gate for AI agent actions, exposed as an MCP server.
 * The gate never executes anything. It records intent, waits for a human decision
 * made out-of-band (via the `approval-gate` CLI), and reports status. Agents are
 * expected to request approval BEFORE performing a consequential action, and to
 * treat anything other than an explicit "approved" as a no.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequest, decide, getRequest, listRequests, gateDir } from "./store.js";

const server = new McpServer({ name: "approval-gate", version: "0.1.0" });

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

server.tool(
  "request_approval",
  "Register a consequential action for human approval BEFORE performing it. Returns a request id. The action is NOT executed by this server; the calling agent must check approval status and only proceed on an explicit 'approved'. Anything else means no (fail closed).",
  {
    action: z.string().min(1).describe("Precise description of the action you intend to take, e.g. 'send email to alice@example.com with subject X'"),
    reason: z.string().min(1).describe("Why this action is needed right now"),
    requested_by: z.string().optional().describe("Identifier of the requesting agent or workflow"),
    ttl_seconds: z.number().int().min(10).max(7 * 24 * 3600).default(3600).describe("How long the request stays pending before it expires (default 1 hour)"),
  },
  async ({ action, reason, requested_by, ttl_seconds }) => {
    const req = await createRequest(action, reason, ttl_seconds, requested_by);
    return text({
      id: req.id,
      status: req.status,
      expiresAt: req.expiresAt,
      note: `A human must run: approval-gate approve ${req.id}  (or: approval-gate deny ${req.id}). Poll with check_approval or block with wait_for_approval. Do not proceed without an explicit 'approved'.`,
    });
  },
);

server.tool(
  "check_approval",
  "Check the current status of an approval request. Statuses: pending, approved, denied, expired. Only 'approved' authorizes the action.",
  { id: z.string().min(1).describe("The request id returned by request_approval") },
  async ({ id }) => {
    const req = await getRequest(id);
    if (!req) return text({ error: `No request with id ${id}` });
    return text(req);
  },
);

server.tool(
  "wait_for_approval",
  "Block until a human decides the request, it expires, or the timeout elapses. Returns the final (or still-pending) request. A timeout returns status 'pending': treat it as NOT approved.",
  {
    id: z.string().min(1).describe("The request id returned by request_approval"),
    timeout_seconds: z.number().int().min(1).max(3600).default(300).describe("Maximum time to wait (default 5 minutes)"),
    poll_seconds: z.number().int().min(1).max(60).default(5).describe("Polling interval"),
  },
  async ({ id, timeout_seconds, poll_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    for (;;) {
      const req = await getRequest(id);
      if (!req) return text({ error: `No request with id ${id}` });
      if (req.status !== "pending") return text(req);
      if (Date.now() >= deadline) return text({ ...req, note: "Timed out while pending. Not approved. Do not proceed." });
      await new Promise((r) => setTimeout(r, Math.min(poll_seconds * 1000, Math.max(0, deadline - Date.now()))));
    }
  },
);

server.tool(
  "list_pending",
  "List all approval requests currently awaiting a human decision.",
  {},
  async () => text(await listRequests("pending")),
);

server.tool(
  "decide_approval",
  "Record a human decision on a pending request. IMPORTANT: this tool exists for setups where the human is driving this very session and asks the agent to record their decision. An agent must NEVER call this on its own initiative to approve its own request; self-approval defeats the gate. Prefer the out-of-band CLI: approval-gate approve <id>.",
  {
    id: z.string().min(1),
    approve: z.boolean().describe("true to approve, false to deny"),
    reason: z.string().optional().describe("Human's stated reason, verbatim"),
  },
  async ({ id, approve, reason }) => {
    const req = await decide(id, approve, reason);
    return text(req);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`approval-gate-mcp ready (state dir: ${gateDir()})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
