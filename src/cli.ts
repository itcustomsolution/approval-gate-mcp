#!/usr/bin/env node
/**
 * approval-gate CLI: the human side of the gate.
 *
 *   approval-gate list [pending|approved|denied|expired] [--limit N] [--after ID]
 *   approval-gate show <id>
 *   approval-gate approve <id> [reason...]
 *   approval-gate deny <id> [reason...]      (pending: deny; approved-unconsumed: revoke)
 *   approval-gate revoke <id> [reason...]
 *   approval-gate archive [--older-than-days N]
 */
import { createInterface } from "node:readline/promises";
import { safe } from "./display.js";
import {
  archiveRequests,
  revokeApproval,
  decide,
  getRequest,
  listRequestPage,
  gateDir,
  isValidId,
  type RequestStatus,
  type RequestSummary,
} from "./store.js";

const STATUSES: RequestStatus[] = ["pending", "approved", "denied", "expired"];

function usage(): never {
  console.log(`approval-gate: human decisions for approval-gate-mcp (state dir: ${safe(gateDir())})

Usage:
  approval-gate list [pending|approved|denied|expired] [--limit N] [--after ID]
  approval-gate show <id>
  approval-gate approve <id> [reason...]
  approval-gate deny <id> [reason...]
  approval-gate revoke <id> [reason...]
  approval-gate archive [--older-than-days N]   (default 30, minimum 8)`);
  process.exit(1);
}

function fmt(req: RequestSummary): string {
  const lines = [
    `${safe(req.id)}  [${safe(req.effectiveStatus ?? req.status)}]  ${safe(req.createdAt)}`,
    `  action: ${safe(req.action)}`,
    `  reason: ${safe(req.reason)}`,
  ];
  if (req.requestedBy) lines.push(`  by:     ${safe(req.requestedBy)} (self-reported)`);
  if (req.operation) lines.push(`  operation: ${safe(req.operation)}`);
  if (req.payloadDigest) lines.push(`  payload sha256: ${safe(req.payloadDigest)}`);
  return lines.join("\n");
}

/** The full approved payload, rendered from its canonical bytes and escaped for the terminal. */
function payloadLines(canonical: string): string {
  return JSON.stringify(JSON.parse(canonical), null, 2).split("\n").map((l) => `    ${safe(l)}`).join("\n");
}

function requireId(arg: string | undefined): string {
  if (!arg) usage();
  if (!isValidId(arg)) throw new Error("invalid request id (expected 12-64 lowercase hexadecimal characters)");
  return arg;
}

/** Approvals require a human at an interactive terminal who re-types a short confirmation. */
async function confirmApproval(id: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("approve requires an interactive terminal (stdin/stdout is not a TTY). This is a speed bump for non-interactive agents, not authentication: anything running as your OS user can still get around it.");
  }
  const req = await getRequest(id);
  if (!req) throw new Error("No request with that id");
  console.log(fmt(req));
  if (req.payloadCanonical !== undefined) console.log(`  payload (exactly what will be bound):\n${payloadLines(req.payloadCanonical)}`);
  console.log("");
  const code = id.slice(-4);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the last 4 characters of the id (${"*".repeat(id.length - 4)}????) to approve: `)).trim();
  rl.close();
  if (answer !== code) throw new Error("Confirmation did not match. Not approved.");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) usage();
  args.splice(i, 2);
  return value;
}

function integer(value: string): number {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error("expected a nonnegative integer");
  return Number(value);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "list": {
      const limit = flag(args, "--limit");
      const after = flag(args, "--after");
      if (args.length > 1 || (args[0] && !STATUSES.includes(args[0] as RequestStatus))) usage();
      const status = (args[0] as RequestStatus | undefined) ?? "pending";
      if (after !== undefined) requireId(after);
      const page = await listRequestPage(status, limit === undefined ? 50 : integer(limit), after);
      if (page.items.length === 0) {
        console.log(`No ${status} requests${after ? " after that id" : ""}.`);
        return;
      }
      for (const r of page.items) console.log(fmt(r) + "\n");
      if (page.nextCursor) console.log(`More requests: approval-gate list ${status} --after ${safe(page.nextCursor)}`);
      return;
    }
    case "show": {
      const req = await getRequest(requireId(args[0]));
      if (!req) {
        console.error("No request with that id");
        process.exit(2);
      }
      console.log(JSON.stringify(req, null, 2).split("\n").map(safe).join("\n"));
      if (req.payloadCanonical !== undefined) console.log(`payload:\n${payloadLines(req.payloadCanonical)}`);
      return;
    }
    case "revoke": {
      const id = requireId(args[0]);
      console.log(fmt(await revokeApproval(id, args.slice(1).join(" ") || undefined)));
      return;
    }
    case "approve":
    case "deny": {
      const id = requireId(args[0]);
      if (cmd === "approve") await confirmApproval(id);
      const req = await decide(id, cmd === "approve", args.slice(1).join(" ") || undefined);
      console.log(fmt(req));
      return;
    }
    case "archive": {
      const days = flag(args, "--older-than-days");
      if (args.length) usage();
      const moved = await archiveRequests(days === undefined ? 30 : integer(days));
      console.log(`Archived ${moved} finished request(s) to ${safe(gateDir())}/archive.`);
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  // Every terminal-bound string is escaped, including messages that embed caller input.
  console.error(safe(err instanceof Error ? err.message : String(err)));
  process.exit(2);
});
