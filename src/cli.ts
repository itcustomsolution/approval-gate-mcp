#!/usr/bin/env node
/**
 * approval-gate CLI: the human side of the gate.
 *
 *   approval-gate list [pending|approved|denied|expired]
 *   approval-gate show <id>
 *   approval-gate approve <id> [reason...]
 *   approval-gate deny <id> [reason...]      (pending: deny; approved-unconsumed: revoke)
 *   approval-gate revoke <id> [reason...]
 */
import { createInterface } from "node:readline/promises";
import { safe } from "./display.js";
import { revokeApproval, decide, getRequest, listRequests, gateDir, type RequestStatus } from "./store.js";

function usage(): never {
  console.log(`approval-gate: human decisions for approval-gate-mcp (state dir: ${gateDir()})

Usage:
  approval-gate list [pending|approved|denied|expired]
  approval-gate show <id>
  approval-gate approve <id> [reason...]
  approval-gate deny <id> [reason...]
  approval-gate revoke <id> [reason...]`);
  process.exit(1);
}

function fmt(req: { effectiveStatus?: string; id: string; status: string; createdAt: string; action: string; reason: string; requestedBy?: string }): string {
  return `${safe(req.id)}  [${safe(req.effectiveStatus ?? req.status)}]  ${safe(req.createdAt)}\n  action: ${safe(req.action)}\n  reason: ${safe(req.reason)}${req.requestedBy ? `\n  by:     ${safe(req.requestedBy)}` : ""}`;
}

/** Approvals require a human at an interactive terminal who re-types a short confirmation. */
async function confirmApproval(id: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("approve requires an interactive terminal (stdin/stdout is not a TTY). This is a speed bump for non-interactive agents, not authentication: anything running as your OS user can still get around it.");
  }
  const req = await getRequest(id);
  if (!req) throw new Error(`No request with id ${id}`);
  console.log(fmt(req) + "\n");
  const code = id.slice(-4);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the last 4 characters of the id (${"*".repeat(id.length - 4)}????) to approve: `)).trim();
  rl.close();
  if (answer !== code) throw new Error("Confirmation did not match. Not approved.");
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
        console.error(`No request with id ${safe(arg)}`);
        process.exit(2);
      }
      console.log(JSON.stringify(req, null, 2).split("\n").map(safe).join("\n"));
      return;
    }
    case "revoke": {
      if (!arg) usage();
      console.log(fmt(await revokeApproval(arg, rest.join(" ") || undefined)));
      return;
    }
    case "approve":
    case "deny": {
      if (!arg) usage();
      if (cmd === "approve") await confirmApproval(arg);
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
