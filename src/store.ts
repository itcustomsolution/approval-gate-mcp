import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Authorization state machine (see docs/authorization-states.md):
 *
 *   pending --approve--> approved(uncommitted) --audit ok--> approved(committed)
 *   pending --deny-----> denied                 (terminal)
 *   pending --TTL------> expired                (terminal)
 *   approved(committed) --consume (now <= expiresAt, action matches)--> consumed (terminal, ok:true once)
 *   approved(*)         --revoke / deny-------------------------------> revoked  (terminal)
 *   approved(*)         --any write/audit failure --------------------> invalidated (terminal)
 *
 * Only a successful consumeApproval() result authorizes execution. `status: "approved"`
 * alone never does.
 */
export type RequestStatus = "pending" | "approved" | "denied" | "expired";
const STATUSES: readonly RequestStatus[] = ["pending", "approved", "denied", "expired"];

export type EffectiveStatus =
  | "pending"
  | "denied"
  | "expired"
  | "approved_uncommitted"
  | "approved_unconsumed"
  | "approved_expired"
  | "consumed"
  | "revoked"
  | "invalidated";

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
  consumedAt?: string;
  revokedAt?: string;
}

export interface RequestView extends ApprovalRequest {
  /** Derived; never "authorized". Only consumeApproval ok:true authorizes. */
  effectiveStatus: EffectiveStatus;
  authorizesExecution: false;
}

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

type MarkerKind = "final" | "committed" | "used";
function requestPath(id: string): string {
  if (!isValidId(id)) throw new Error("invalid request id");
  return path.join(requestsDir(), `${id}.json`);
}
function markerPath(id: string, kind: MarkerKind): string {
  if (!isValidId(id)) throw new Error("invalid request id");
  return path.join(requestsDir(), `${id}.${kind}`);
}

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

/** Refuse symlinks / foreign owners; tighten loose permissions left by older versions. */
async function securePath(p: string, kind: "dir" | "file", mode: number): Promise<void> {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink()) throw new Error(`refusing to use ${p}: it is a symlink`);
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) throw new Error(`refusing to use ${p}: unexpected file type`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`refusing to use ${p}: owned by another user`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    await fs.chmod(p, mode);
    const again = await fs.lstat(p);
    if ((again.mode & 0o077) !== 0) throw new Error(`refusing to use ${p}: could not restrict permissions`);
  }
}

let migratedFor: string | undefined;
async function ensureDirs(): Promise<void> {
  await fs.mkdir(requestsDir(), { recursive: true, mode: 0o700 });
  await securePath(gateDir(), "dir", 0o700);
  await securePath(requestsDir(), "dir", 0o700);
  try {
    await securePath(auditPath(), "file", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (migratedFor !== gateDir()) {
    // One-time upgrade sweep: request/marker files written by <=0.1.x with 0644.
    for (const f of await fs.readdir(requestsDir())) {
      if (f.endsWith(".tmp")) continue;
      await securePath(path.join(requestsDir(), f), "file", 0o600);
    }
    migratedFor = gateDir();
  }
}

/** Append one audit line and fsync it. Throws on any failure. */
export async function audit(event: string, data: Record<string, unknown>): Promise<void> {
  await ensureDirs();
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n";
  const fh = await fs.open(auditPath(), "a", 0o600);
  try {
    await fh.writeFile(line, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(dest: string, content: string): Promise<string> {
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  return tmp;
}

async function writeRequest(req: ApprovalRequest): Promise<void> {
  await ensureDirs();
  const dest = requestPath(req.id);
  const tmp = await writeAtomic(dest, JSON.stringify(req, null, 2));
  await fs.rename(tmp, dest);
}

/**
 * Exclusive marker whose content is complete before it becomes visible: the content is written
 * and fsynced to a temp file, then hard-linked into place (link(2) fails with EEXIST atomically).
 * A crash can leave only an orphan .tmp, never an empty or half-written marker.
 */
async function claimMarker(p: string, content: string): Promise<boolean> {
  await ensureDirs();
  const tmp = await writeAtomic(p, content);
  try {
    await fs.link(tmp, p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function readMarker(id: string, kind: MarkerKind): Promise<string | undefined> {
  try {
    return (await fs.readFile(markerPath(id, kind), "utf8")).trim();
  } catch {
    return undefined;
  }
}

function parseRequest(raw: string, id: string): ApprovalRequest | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const r = obj as Record<string, unknown>;
  if (r.id !== id) return undefined;
  if (typeof r.action !== "string" || typeof r.reason !== "string") return undefined;
  if (typeof r.status !== "string" || !STATUSES.includes(r.status as RequestStatus)) return undefined;
  if (typeof r.createdAt !== "string" || typeof r.expiresAt !== "string") return undefined;
  return r as unknown as ApprovalRequest;
}

function isPastExpiry(req: ApprovalRequest, now = Date.now()): boolean {
  const t = Date.parse(req.expiresAt);
  return !Number.isFinite(t) || now > t;
}

async function readRaw(id: string): Promise<ApprovalRequest | undefined> {
  if (!isValidId(id)) return undefined;
  try {
    await ensureDirs();
    return parseRequest(await fs.readFile(requestPath(id), "utf8"), id);
  } catch (err) {
    if (err instanceof Error && /^refusing to use/.test(err.message)) throw err;
    return undefined;
  }
}

/** The .final marker is authoritative over the JSON status (reconciles crashes between the two writes). */
async function reconciled(id: string): Promise<ApprovalRequest | undefined> {
  const req = await readRaw(id);
  if (!req) return undefined;
  const final = await readMarker(id, "final");
  if (final && STATUSES.includes(final as RequestStatus) && final !== "pending") return { ...req, status: final as RequestStatus };
  if (final) return { ...req, status: "denied" }; // unknown marker content: fail closed
  if (req.status !== "pending") return { ...req, status: "denied" }; // terminal JSON without a decision record: fail closed
  if (isPastExpiry(req)) {
    if (await claimMarker(markerPath(id, "final"), "expired")) {
      const expired: ApprovalRequest = { ...req, status: "expired", decidedAt: new Date().toISOString(), decisionReason: "TTL expired" };
      await writeRequest(expired).catch(() => {});
      await audit("expired", { id, action: req.action }).catch(() => {});
      return expired;
    }
    return reconciled(id);
  }
  return req;
}

async function effective(req: ApprovalRequest): Promise<EffectiveStatus> {
  if (req.status !== "approved") return req.status;
  const used = await readMarker(req.id, "used");
  if (used?.startsWith("consume")) return "consumed";
  if (used === "revoked") return "revoked";
  if (used) return "invalidated";
  if ((await readMarker(req.id, "committed")) !== "committed") return "approved_uncommitted";
  if (isPastExpiry(req)) return "approved_expired";
  return "approved_unconsumed";
}

export async function getRequest(id: string): Promise<RequestView | undefined> {
  const req = await reconciled(id);
  if (!req) return undefined;
  return { ...req, effectiveStatus: await effective(req), authorizesExecution: false };
}

export async function createRequest(action: string, reason: string, ttlSeconds: number, requestedBy?: string): Promise<RequestView> {
  const now = new Date();
  const req: ApprovalRequest = {
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
  return { ...req, effectiveStatus: "pending", authorizesExecution: false };
}

export async function listRequests(status?: RequestStatus): Promise<RequestView[]> {
  await ensureDirs();
  const out: RequestView[] = [];
  for (const f of await fs.readdir(requestsDir())) {
    if (!f.endsWith(".json")) continue;
    const req = await getRequest(f.slice(0, -5));
    if (req && (!status || req.status === status)) out.push(req);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Best-effort: make an approval permanently unusable. */
async function invalidate(id: string, why: string): Promise<void> {
  await claimMarker(markerPath(id, "used"), `invalidated:${why}`).catch(() => {});
}

/** Revoke an approved, not-yet-consumed approval. Linearized against consumption by the .used marker. */
export async function revokeApproval(id: string, reason?: string): Promise<RequestView> {
  const req = await reconciled(id);
  if (!req) throw new Error(`No request with id ${id}`);
  if (req.status !== "approved") throw new Error(`Request ${id} is ${req.status}, not approved`);
  if (!(await claimMarker(markerPath(id, "used"), "revoked"))) {
    throw new Error(`Request ${id} is already ${await effective(req)}`);
  }
  const revoked = { ...req, revokedAt: new Date().toISOString() };
  await writeRequest(revoked).catch(() => {});
  await audit("revoked", { id, action: req.action, reason }).catch(() => {});
  return { ...revoked, effectiveStatus: "revoked", authorizesExecution: false };
}

export async function decide(id: string, approve: boolean, reason?: string): Promise<RequestView> {
  const req = await reconciled(id);
  if (!req) throw new Error(`No request with id ${id}`);
  if (!approve && req.status === "approved") return revokeApproval(id, reason);
  if (req.status !== "pending") throw new Error(`Request ${id} is already ${req.status}`);
  // Decide the marker content at claim time: an approval that would win after the deadline is recorded as expired.
  const status: RequestStatus = approve ? (isPastExpiry(req) ? "expired" : "approved") : "denied";
  if (!(await claimMarker(markerPath(id, "final"), status))) {
    const now = await reconciled(id);
    throw new Error(`Request ${id} is already ${now?.status ?? "decided"}`);
  }
  if (approve && status === "expired") {
    await writeRequest({ ...req, status, decidedAt: new Date().toISOString(), decisionReason: "TTL expired" }).catch(() => {});
    await audit("expired", { id, action: req.action }).catch(() => {});
    throw new Error(`Request ${id} is already expired`);
  }
  const decided: ApprovalRequest = { ...req, status, decidedAt: new Date().toISOString(), decisionReason: reason };
  try {
    await writeRequest(decided);
    await audit(status, { id, action: req.action, reason });
  } catch (err) {
    // Denials stay denied via the marker. An approval whose record or audit did not persist must never be usable.
    if (approve) await invalidate(id, "decision_write_failed");
    throw err;
  }
  if (approve && !(await claimMarker(markerPath(id, "committed"), "committed"))) {
    await invalidate(id, "commit_conflict");
    throw new Error(`Request ${id} could not be committed`);
  }
  return { ...decided, effectiveStatus: approve ? await effective(decided) : "denied", authorizesExecution: false };
}

export type ConsumeResult =
  | { ok: true; id: string; action: string; consumedAt: string; expiresAt: string }
  | { ok: false; error: string; effectiveStatus?: EffectiveStatus };

/**
 * The only operation that authorizes execution. Succeeds at most once per request, only if:
 * the decision is approved and committed (audit persisted), `action` matches exactly, the
 * exclusive .used claim is won, and the clock read AFTER winning that claim is <= expiresAt.
 */
export async function consumeApproval(id: string, action: string): Promise<ConsumeResult> {
  const req = await reconciled(id);
  if (!req) return { ok: false, error: "not_found" };
  const eff = await effective(req);
  if (eff !== "approved_unconsumed") return { ok: false, error: "not_usable", effectiveStatus: eff };
  if (action !== req.action) return { ok: false, error: "action_mismatch", effectiveStatus: eff };
  const claimedAt = new Date().toISOString();
  if (!(await claimMarker(markerPath(id, "used"), `consume-claimed ${claimedAt}`))) {
    return { ok: false, error: "already_used", effectiveStatus: await effective(req) };
  }
  // Check-vs-use: expiry is evaluated after the exclusive claim, so no approval is usable past its deadline.
  if (isPastExpiry(req)) {
    await audit("consume_rejected_expired", { id }).catch(() => {});
    return { ok: false, error: "approval_expired", effectiveStatus: "consumed" };
  }
  try {
    await writeRequest({ ...req, consumedAt: claimedAt });
    await audit("consumed", { id, action });
  } catch {
    // The approval is already burned (.used claimed); refuse rather than authorize without an audit record.
    return { ok: false, error: "audit_failed", effectiveStatus: "consumed" };
  }
  return { ok: true, id, action, consumedAt: claimedAt, expiresAt: req.expiresAt };
}

/**
 * Helper for the trusted execution boundary: throws unless `result` is a successful consume for
 * exactly this id and action. Use it right before performing the side effect.
 */
export function assertConsumed(result: unknown, id: string, action: string): void {
  const r = result as Partial<Extract<ConsumeResult, { ok: true }>> | null;
  if (!r || r.ok !== true || r.id !== id || r.action !== action || typeof r.consumedAt !== "string") {
    throw new Error("not authorized: no valid consume_approval result for this id and action");
  }
}
