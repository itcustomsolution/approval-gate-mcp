import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type RequestStatus = "pending" | "approved" | "denied" | "expired";
const STATUSES: readonly RequestStatus[] = ["pending", "approved", "denied", "expired"];

export interface ApprovalRequest {
  id: string;
  action: string;
  reason: string;
  requestedBy?: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decisionReason?: string;
  /** Set once the approval has been consumed by consumeApproval (single use). */
  consumedAt?: string;
}

/** Ids we generate are lowercase hex. Anything else is rejected outright (no sanitizing into a different id). */
const ID_RE = /^[0-9a-f]{12,64}$/;
export function isValidId(id: string): boolean {
  return typeof id === "string" && ID_RE.test(id);
}

export function gateDir(): string {
  return process.env.APPROVAL_GATE_DIR ?? path.join(os.homedir(), ".approval-gate");
}

function requestsDir(): string {
  return path.join(gateDir(), "requests");
}

function auditPath(): string {
  return path.join(gateDir(), "audit.jsonl");
}

async function ensureDirs(): Promise<void> {
  // 0700: other local users cannot read intents or forge decisions.
  await fs.mkdir(requestsDir(), { recursive: true, mode: 0o700 });
}

export async function audit(event: string, data: Record<string, unknown>): Promise<void> {
  await ensureDirs();
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  await fs.appendFile(auditPath(), line + "\n", { encoding: "utf8", mode: 0o600 });
}

function requestPath(id: string): string {
  if (!isValidId(id)) throw new Error("invalid request id");
  return path.join(requestsDir(), `${id}.json`);
}

function markerPath(id: string, kind: "final" | "used"): string {
  if (!isValidId(id)) throw new Error("invalid request id");
  return path.join(requestsDir(), `${id}.${kind}`);
}

/** Atomic write (temp file + rename) so a crash or concurrent reader never sees a torn file. */
async function writeRequest(req: ApprovalRequest): Promise<void> {
  await ensureDirs();
  const dest = requestPath(req.id);
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(req, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, dest);
}

/**
 * Exclusive one-time marker (O_CREAT|O_EXCL). Returns true only for the single caller that
 * created it. Used so that exactly one terminal transition (approve/deny/expire) and exactly
 * one consumption can ever win, even under concurrent callers.
 */
async function claimMarker(p: string, content: string): Promise<boolean> {
  try {
    const fh = await fs.open(p, "wx", 0o600);
    await fh.writeFile(content, "utf8");
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Strict parse of a state file. Malformed or inconsistent data is treated as missing (fail closed). */
function parseRequest(raw: string, id: string): ApprovalRequest | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const r = obj as Record<string, unknown>;
  if (r.id !== id) return undefined; // a file copied/renamed onto another id is not trusted
  if (typeof r.action !== "string" || typeof r.reason !== "string") return undefined;
  if (typeof r.status !== "string" || !STATUSES.includes(r.status as RequestStatus)) return undefined;
  if (typeof r.createdAt !== "string" || typeof r.expiresAt !== "string") return undefined;
  return r as unknown as ApprovalRequest;
}

function isPastExpiry(req: ApprovalRequest): boolean {
  const t = Date.parse(req.expiresAt);
  // An unparseable expiry must never mean "never expires".
  return !Number.isFinite(t) || Date.now() > t;
}

/** Applies TTL: a pending request past its expiry becomes expired (persisted). Fail closed. */
async function applyExpiry(req: ApprovalRequest): Promise<ApprovalRequest> {
  if (req.status === "pending" && isPastExpiry(req)) {
    if (await claimMarker(markerPath(req.id, "final"), "expired")) {
      const expired: ApprovalRequest = { ...req, status: "expired", decidedAt: new Date().toISOString(), decisionReason: "TTL expired" };
      await writeRequest(expired);
      await audit("expired", { id: req.id, action: req.action });
      return expired;
    }
    // Someone else finalized it concurrently; report the expired view without trusting a stale 'pending'.
    return { ...req, status: "expired" };
  }
  return req;
}

export async function createRequest(action: string, reason: string, ttlSeconds: number, requestedBy?: string): Promise<ApprovalRequest> {
  const now = new Date();
  const req: ApprovalRequest = {
    // 128 bits: ids are not guessable.
    id: crypto.randomBytes(16).toString("hex"),
    action,
    reason,
    requestedBy,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  await writeRequest(req);
  await audit("requested", { id: req.id, action, reason, requestedBy });
  return req;
}

async function readRaw(id: string): Promise<ApprovalRequest | undefined> {
  if (!isValidId(id)) return undefined;
  try {
    return parseRequest(await fs.readFile(requestPath(id), "utf8"), id);
  } catch {
    return undefined;
  }
}

export async function getRequest(id: string): Promise<ApprovalRequest | undefined> {
  const req = await readRaw(id);
  if (!req) return undefined;
  return applyExpiry(req);
}

export async function listRequests(status?: RequestStatus): Promise<ApprovalRequest[]> {
  await ensureDirs();
  const files = await fs.readdir(requestsDir());
  const out: ApprovalRequest[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const req = await getRequest(f.slice(0, -5));
    if (req && (!status || req.status === status)) out.push(req);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function decide(id: string, approve: boolean, reason?: string): Promise<ApprovalRequest> {
  const req = await getRequest(id);
  if (!req) throw new Error(`No request with id ${id}`);
  if (req.status !== "pending") throw new Error(`Request ${id} is already ${req.status}`);
  const status: RequestStatus = approve ? "approved" : "denied";
  // Only one terminal transition can ever win (approve vs deny vs expiry race).
  if (!(await claimMarker(markerPath(id, "final"), status))) {
    const now = await readRaw(id);
    throw new Error(`Request ${id} is already ${now?.status ?? "decided"}`);
  }
  const decided: ApprovalRequest = { ...req, status, decidedAt: new Date().toISOString(), decisionReason: reason };
  await writeRequest(decided);
  await audit(status, { id, action: req.action, reason });
  return decided;
}

export type ConsumeResult = { ok: true; request: ApprovalRequest } | { ok: false; error: string; status?: RequestStatus };

/**
 * Single-use, action-bound check an agent should call immediately before acting.
 * Succeeds exactly once, only if the request is approved, the approval has not
 * passed the request's expiry, and `action` matches the approved text exactly.
 */
export async function consumeApproval(id: string, action: string): Promise<ConsumeResult> {
  const req = await getRequest(id);
  if (!req) return { ok: false, error: "not_found" };
  if (req.status !== "approved") return { ok: false, error: "not_approved", status: req.status };
  if (isPastExpiry(req)) return { ok: false, error: "approval_expired", status: req.status };
  if (action !== req.action) return { ok: false, error: "action_mismatch", status: req.status };
  // The final marker must agree; a hand-edited 'approved' file without a recorded decision is rejected.
  let finalMark = "";
  try {
    finalMark = (await fs.readFile(markerPath(id, "final"), "utf8")).trim();
  } catch {
    /* missing */
  }
  if (finalMark !== "approved") return { ok: false, error: "decision_record_mismatch", status: req.status };
  if (!(await claimMarker(markerPath(id, "used"), new Date().toISOString()))) {
    return { ok: false, error: "already_consumed", status: req.status };
  }
  const consumed: ApprovalRequest = { ...req, consumedAt: new Date().toISOString() };
  await writeRequest(consumed);
  await audit("consumed", { id, action });
  return { ok: true, request: consumed };
}
