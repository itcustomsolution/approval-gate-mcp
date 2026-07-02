#!/usr/bin/env node
/**
 * approval-gate CLI: the human side of the gate.
 *
 *   approval-gate list [pending|approved|denied|expired]
 *   approval-gate show <id>
 *   approval-gate approve <id> [reason...]
 *   approval-gate deny <id> [reason...]
 */
import { decide, getRequest, listRequests, gateDir, type RequestStatus } from "./store.js";

function usage(): never {
  console.log(`approval-gate: human decisions for approval-gate-mcp (state dir: ${gateDir()})

Usage:
  approval-gate list [pending|approved|denied|expired]
  approval-gate show <id>
  approval-gate approve <id> [reason...]
  approval-gate deny <id> [reason...]`);
  process.exit(1);
}

function fmt(req: { id: string; status: string; createdAt: string; action: string; reason: string }): string {
  return `${req.id}  [${req.status}]  ${req.createdAt}\n  action: ${req.action}\n  reason: ${req.reason}`;
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list": {
      const statuses: RequestStatus[] = ["pending", "approved", "denied", "expired"];
      const status = arg && statuses.includes(arg as RequestStatus) ? (arg as RequestStatus) : arg ? usage() : "pending";
      const reqs = await listRequests(status);
      if (reqs.length === 0) {
        console.log(`No ${status} requests.`);
        return;
      }
      for (const r of reqs) console.log(fmt(r) + "\n");
      return;
    }
    case "show": {
      if (!arg) usage();
      const req = await getRequest(arg);
      if (!req) {
        console.error(`No request with id ${arg}`);
        process.exit(2);
      }
      console.log(JSON.stringify(req, null, 2));
      return;
    }
    case "approve":
    case "deny": {
      if (!arg) usage();
      const req = await decide(arg, cmd === "approve", rest.join(" ") || undefined);
      console.log(fmt(req));
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
