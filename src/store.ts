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
 *   approved(committed) --consume (now <= expiresAt, action/binding matches)--> consumed (terminal, ok:true once)
 *   approved(*)         --revoke / deny-------------------------------> revoked  (terminal)
 *   approved(*)         --any write/audit failure --------------------> invalidated (terminal)
 *
 * Only a successful consume authorizes execution: consumeApproval() ok:true for the cooperating
 * agent, or executeApproved() for trusted in-process code. `status: "approved"` alone never does.
 */
export type RequestStatus = "pending" | "approved" | "denied" | "expired";
const STATUSES: readonly RequestStatus[] = ["pending", "approved", "denied", "expired"];

/** Byte limits (UTF-8) apply to MCP, CLI and direct library callers alike. */
export const LIMITS = Object.freeze({
  action: 8192,
  reason: 8192,
  requestedBy: 256,
  operation: 128,
  payloadBytes: 32 * 1024,
  payloadDepth: 32,
  payloadValues: 10_000,
  page: 100,
  maxTtlSeconds: 7 * 24 * 3600,
});
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_AUDIT_LINE_BYTES = 256 * 1024;
// ponytail: listing and creation collect whole-directory scans; archive old requests (`approval-gate archive`) if a
// long-lived install nears this. Creation stops at half the cap, so self-denied requests from an agent cannot push
// the directory to the point where the human-side listing fails (pending markers and orphans fit in the other half).
const MAX_STATE_ENTRIES = 200_000;
const CREATE_ENTRY_LIMIT = MAX_STATE_ENTRIES / 2;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function boundedText(value: unknown, name: string, max: number, required = true): asserts value is string {
  if (typeof value !== "string" || (required && value.length === 0) || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`${name} must be ${required ? "nonempty and " : ""}at most ${max} UTF-8 bytes`);
  }
}

/** Queue bound: requests awaiting a human decision. Invalid configuration fails closed. */
function maxPending(): number {
  const raw = process.env.APPROVAL_GATE_MAX_PENDING ?? "100";
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 10_000) {
    throw new Error("APPROVAL_GATE_MAX_PENDING must be an integer from 1 to 10000");
  }
  return Number(raw);
}

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

/** Never consumable again. Only these are ever archived. */
const TERMINAL: ReadonlySet<EffectiveStatus> = new Set(["denied", "expired", "approved_uncommitted", "approved_expired", "consumed", "revoked", "invalidated"]);

export interface ApprovalRequest {
  id: string;
  action: string;
  reason: string;
  requestedBy?: string;
  /** Optional operation name the trusted executor must present, e.g. "smtp.send". */
  operation?: string;
  /** RFC 8785 canonical JSON of the approved payload, exactly the bytes behind payloadDigest. */
  payloadCanonical?: string;
  /** SHA-256 (hex) of payloadCanonical. */
  payloadDigest?: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decisionReason?: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface RequestView extends ApprovalRequest {
  /** Derived; never "authorized". Only a successful consume authorizes. */
  effectiveStatus: EffectiveStatus;
  authorizesExecution: false;
}

/** What the trusted executor binds an approval to, beyond its id. */
export interface Binding {
  operation?: string;
  /** Any JSON value; compared by RFC 8785 canonical form and SHA-256. */
  payload?: unknown;
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

// Lone UTF-16 surrogates are not valid I-JSON (RFC 7493), which RFC 8785 requires.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * RFC 8785 (JCS) canonical JSON for plain JSON values. ECMAScript JSON.stringify already produces the
 * JCS form of strings and finite numbers, and default sort() orders keys by UTF-16 code units.
 */
export function canonicalJson(value: unknown): string {
  const budget = { values: 0, chars: 0 };
  const out = canon(value, 0, budget);
  if (Buffer.byteLength(out, "utf8") > LIMITS.payloadBytes) throw new Error(`payload must be at most ${LIMITS.payloadBytes} UTF-8 bytes in canonical form`);
  return out;
}

function canon(value: unknown, depth: number, budget: { values: number; chars: number }): string {
  if (++budget.values > LIMITS.payloadValues) throw new Error(`payload must contain at most ${LIMITS.payloadValues} JSON values`);
  if (depth > LIMITS.payloadDepth) throw new Error(`payload nesting must be at most ${LIMITS.payloadDepth} levels`);
  const str = (s: string) => {
    budget.chars += s.length;
    if (budget.chars > LIMITS.payloadBytes) throw new Error(`payload must be at most ${LIMITS.payloadBytes} UTF-8 bytes in canonical form`);
    if (LONE_SURROGATE.test(s)) throw new Error("payload strings must be well-formed Unicode");
    return JSON.stringify(s);
  };
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("payload arrays must be plain JSON arrays");
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("payload arrays must not have holes");
      parts.push(canon(value[i], depth + 1, budget));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("payload objects must be plain JSON objects");
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      // JSON.parse keeps "__proto__" as data, but copying it (Object.assign, spread into a setter) would set a prototype.
      if (key === "__proto__") throw new Error('payload objects must not use the key "__proto__"');
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !("value" in desc)) throw new Error("payload objects must not have accessor properties");
      parts.push(`${str(key)}:${canon(desc.value, depth + 1, budget)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("payload must contain only JSON values (null, boolean, finite number, string, array, object)");
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function validOperation(operation: unknown): asserts operation is string {
  if (typeof operation !== "string" || !OPERATION_RE.test(operation)) {
    throw new Error("operation must be 1-128 characters of A-Z a-z 0-9 . _ : / - (starting with a letter or digit)");
  }
}

/** Compares a stored request's binding with what the consumer presents. Both sides must agree on what is bound. */
function bindingError(stored: { operation?: string; payloadDigest?: string }, binding: Binding): string | undefined {
  if (binding.operation !== undefined) validOperation(binding.operation);
  if (stored.operation !== binding.operation) return stored.operation === undefined ? "operation_not_bound" : "operation_mismatch";
  const presented = binding.payload === undefined ? undefined : sha256(canonicalJson(binding.payload));
  if (stored.payloadDigest !== presented) return stored.payloadDigest === undefined ? "payload_not_bound" : "payload_mismatch";
  return undefined;
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

/** Entry names one at a time, never all held: the migration sweep and archive must work at any directory size. */
async function* streamEntries(): AsyncGenerator<string> {
  for await (const entry of await fs.opendir(requestsDir())) yield entry.name;
}

/** Collected directory scans have an absolute bound even for externally corrupted state. */
async function requestEntries(): Promise<string[]> {
  const entries: string[] = [];
  for await (const name of streamEntries()) {
    if (entries.length >= MAX_STATE_ENTRIES) {
      throw new Error(`state directory has more than ${MAX_STATE_ENTRIES} entries; run \`approval-gate archive\` (it moves finished requests older than 8 days) or review it manually`);
    }
    entries.push(name);
  }
  return entries;
}

let migratedFor: string | undefined;
async function ensureDirs(): Promise<void> {
  maxPending(); // Invalid configuration must fail closed, including on reads.
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
    for await (const f of streamEntries()) {
      if (f.endsWith(".tmp")) continue;
      await securePath(path.join(requestsDir(), f), "file", 0o600);
    }
    migratedFor = gateDir();
  }
}

function auditLine(event: string, data: Record<string, unknown>): string {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_AUDIT_LINE_BYTES) throw new Error(`audit event exceeds ${MAX_AUDIT_LINE_BYTES} UTF-8 bytes`);
  return line;
}

/** Append one audit line and fsync it. Throws on any failure. */
export async function audit(event: string, data: Record<string, unknown>): Promise<void> {
  await ensureDirs();
  const line = auditLine(event, data);
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

function serialize(req: ApprovalRequest): string {
  const text = JSON.stringify(req, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new Error(`request record exceeds ${MAX_RECORD_BYTES} UTF-8 bytes`);
  return text;
}

async function writeRequest(req: ApprovalRequest): Promise<void> {
  await ensureDirs();
  const dest = requestPath(req.id);
  const tmp = await writeAtomic(dest, serialize(req));
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

/** Reads at most maxBytes, even if an external writer grows the file after stat. */
async function readBounded(p: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(p, "r");
  try {
    if ((await fh.stat()).size > maxBytes) throw new Error("state file exceeds size limit");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fh.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error("state file exceeds size limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Content that matches no state: an existing marker that cannot be read always fails closed. */
const UNREADABLE = "\u0000unreadable";

/** undefined only when the marker does not exist. */
async function readMarker(id: string, kind: MarkerKind): Promise<string | undefined> {
  try {
    return (await readBounded(markerPath(id, kind), 256)).trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : UNREADABLE;
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
  if (r.operation !== undefined && (typeof r.operation !== "string" || !OPERATION_RE.test(r.operation))) return undefined;
  // A payload record must be internally consistent; anything else is corruption and fails closed (not found).
  if (r.payloadCanonical !== undefined || r.payloadDigest !== undefined) {
    if (typeof r.payloadCanonical !== "string" || typeof r.payloadDigest !== "string" || !DIGEST_RE.test(r.payloadDigest)) return undefined;
    if (sha256(r.payloadCanonical) !== r.payloadDigest) return undefined;
  }
  return r as unknown as ApprovalRequest;
}

function isPastExpiry(req: { expiresAt: string }, now = Date.now()): boolean {
  const t = Date.parse(req.expiresAt);
  return !Number.isFinite(t) || now > t;
}

async function readRaw(id: string): Promise<ApprovalRequest | undefined> {
  if (!isValidId(id)) return undefined;
  try {
    await ensureDirs();
    return parseRequest(await readBounded(requestPath(id), MAX_RECORD_BYTES), id);
  } catch (err) {
    if (err instanceof Error && /^(refusing to use|APPROVAL_GATE_MAX_PENDING|state directory has more)/.test(err.message)) throw err;
    return undefined;
  }
}

/** The .final marker is authoritative over the JSON status (reconciles crashes between the two writes). */
async function reconciled(id: string, attempt = 0): Promise<ApprovalRequest | undefined> {
  const req = await readRaw(id);
  if (!req) return undefined;
  const final = await readMarker(id, "final");
  if (final === "expired") return { ...req, status: "expired", decidedAt: req.decidedAt ?? req.expiresAt, decisionReason: req.decisionReason ?? "TTL expired" };
  if (final !== undefined && STATUSES.includes(final as RequestStatus) && final !== "pending") return { ...req, status: final as RequestStatus };
  if (final !== undefined) return { ...req, status: "denied" }; // unknown, empty or unreadable marker: fail closed
  if (req.status !== "pending") return { ...req, status: "denied" }; // terminal JSON without a decision record: fail closed
  if (isPastExpiry(req)) {
    if (await claimMarker(markerPath(id, "final"), "expired")) {
      // The marker is the record of expiry. The JSON file is not rewritten: a reader racing an archive run could
      // otherwise recreate a record the archive had just moved (re-audit RA-AG-02).
      await audit("expired", { id, action: req.action }).catch(() => {});
      return { ...req, status: "expired", decidedAt: req.decidedAt ?? req.expiresAt, decisionReason: req.decisionReason ?? "TTL expired" };
    }
    // Lost the claim to a concurrent decision; re-read it. A marker that keeps vanishing fails closed.
    return attempt < 3 ? reconciled(id, attempt + 1) : { ...req, status: "denied" };
  }
  return req;
}

async function effective(req: ApprovalRequest): Promise<EffectiveStatus> {
  if (req.status !== "approved") return req.status;
  const used = await readMarker(req.id, "used");
  if (used?.startsWith("consume")) return "consumed";
  if (used === "revoked") return "revoked";
  if (used !== undefined) return "invalidated";
  if ((await readMarker(req.id, "committed")) !== "committed") return "approved_uncommitted";
  if (isPastExpiry(req)) return "approved_expired";
  return "approved_unconsumed";
}

export async function getRequest(id: string): Promise<RequestView | undefined> {
  const req = await reconciled(id);
  if (!req) return undefined;
  return { ...req, effectiveStatus: await effective(req), authorizesExecution: false };
}

/** Ids with a request record but no decision marker: what awaits a human. Directory listing only. */
async function undecidedIds(names?: string[]): Promise<string[]> {
  names ??= await requestEntries();
  const decided = new Set(names.filter((n) => n.endsWith(".final")).map((n) => n.slice(0, -6)));
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => isValidId(id) && !decided.has(id));
}

/**
 * Creates a pending request. `ttlSeconds` may be zero or negative (an already-expired request; fail closed)
 * but not more than 7 days. The MCP tool additionally requires an integer from 10 to 604800.
 * Concurrent creators can overshoot APPROVAL_GATE_MAX_PENDING by at most their own number; it is an
 * availability bound for the human queue, not a security control.
 */
export async function createRequest(
  action: string,
  reason: string,
  ttlSeconds: number,
  requestedBy?: string,
  binding: Binding = {},
): Promise<RequestView> {
  boundedText(action, "action", LIMITS.action);
  boundedText(reason, "reason", LIMITS.reason);
  if (requestedBy !== undefined) boundedText(requestedBy, "requestedBy", LIMITS.requestedBy, false);
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds > LIMITS.maxTtlSeconds || Number.isNaN(new Date(Date.now() + ttlSeconds * 1000).getTime())) {
    throw new Error(`ttlSeconds must be a finite number of seconds, at most ${LIMITS.maxTtlSeconds}`);
  }
  if (binding.operation !== undefined) validOperation(binding.operation);
  const payloadCanonical = binding.payload === undefined ? undefined : canonicalJson(binding.payload);

  await ensureDirs();
  const limit = maxPending();
  const names = await requestEntries();
  if (names.length >= CREATE_ENTRY_LIMIT) {
    throw new Error(`state directory holds ${names.length} entries (limit ${CREATE_ENTRY_LIMIT} for new requests); a human must run \`approval-gate archive\` or review it`);
  }
  if ((await undecidedIds(names)).length >= limit) {
    // Expire stale ones, and give a terminal record that lacks its decision marker one, so it stops counting.
    for (const id of await undecidedIds()) {
      const r = await reconciled(id).catch(() => undefined);
      if (r && r.status !== "pending") await claimMarker(markerPath(id, "final"), r.status).catch(() => {});
    }
    const waiting = (await undecidedIds()).length;
    if (waiting >= limit) {
      throw new Error(`approval queue full: ${waiting} requests await a decision (APPROVAL_GATE_MAX_PENDING=${limit}); a human must decide some, or let them expire`);
    }
  }
  const now = new Date();
  const req: ApprovalRequest = {
    id: crypto.randomBytes(16).toString("hex"),
    action,
    reason,
    requestedBy,
    operation: binding.operation,
    payloadCanonical,
    payloadDigest: payloadCanonical === undefined ? undefined : sha256(payloadCanonical),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  const auditData = { id: req.id, action, reason, requestedBy, operation: req.operation, payloadDigest: req.payloadDigest };
  // LIMITS keep the worst case (6x JSON escaping of every text field) under MAX_RECORD_BYTES and the audit cap.
  // The audit line is written (fsync) before the request file exists, so no crash can leave an approvable
  // request without it. A crash in between leaves only an audit line for a request that never existed.
  await audit("requested", auditData);
  try {
    await writeRequest(req);
  } catch (err) {
    await audit("request_not_created", { id: req.id }).catch(() => {});
    throw err;
  }
  return { ...req, effectiveStatus: "pending", authorizesExecution: false };
}

export type RequestSummary = Omit<RequestView, "payloadCanonical">;

export interface RequestPage {
  items: RequestSummary[];
  /** Present only when more matching requests exist. Pass it back as `cursor` for the next page. */
  nextCursor?: string;
}

async function allViews(): Promise<RequestView[]> {
  await ensureDirs();
  const out: RequestView[] = [];
  for (const f of await requestEntries()) {
    if (!f.endsWith(".json")) continue;
    const req = await getRequest(f.slice(0, -5));
    if (req) out.push(req);
  }
  return out;
}

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Oldest first (createdAt, then id), at most 100 per page. Summaries omit the payload text
 * (payloadDigest and operation remain); read one request with getRequest for the full record.
 */
export async function listRequestPage(status?: RequestStatus, limit = 50, cursor?: string): Promise<RequestPage> {
  if (status !== undefined && !STATUSES.includes(status)) throw new Error("invalid request status");
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.page) throw new Error(`limit must be an integer from 1 to ${LIMITS.page}`);
  if (cursor !== undefined && !isValidId(cursor)) throw new Error("invalid page cursor");
  let items = (await allViews()).filter((r) => !status || r.status === status).sort(byCreated);
  if (cursor !== undefined) {
    const after = await readRaw(cursor);
    if (!after) throw new Error("unknown page cursor; restart the listing");
    items = items.filter((r) => byCreated(r, after) > 0);
  }
  const page = items.slice(0, limit).map(({ payloadCanonical: _omitted, ...summary }) => summary);
  return items.length > limit ? { items: page, nextCursor: page[page.length - 1].id } : { items: page };
}

/** All matching requests, oldest first (unchanged 0.x behavior). Prefer listRequestPage for bounded output. */
export async function listRequests(status?: RequestStatus): Promise<RequestView[]> {
  if (status !== undefined && !STATUSES.includes(status)) throw new Error("invalid request status");
  return (await allViews()).filter((r) => !status || r.status === status).sort(byCreated);
}

/**
 * Moves without replacing: false if the source is gone or a different file already exists at the destination.
 * If the destination is the same file (a crash between link and unlink), the interrupted move is completed.
 */
async function moveNoClobber(from: string, to: string): Promise<boolean> {
  try {
    await fs.link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const [a, b] = await Promise.all([fs.lstat(from), fs.lstat(to)]).catch(() => [undefined, undefined]);
      if (!a || !b || a.ino !== b.ino || a.dev !== b.dev) return false;
    } else if (code === "ENOENT") {
      return false;
    } else {
      throw err;
    }
  }
  // A concurrent archive run may have completed the same move first.
  await fs.unlink(from).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  return true;
}

const MARKER_FILE_RE = /^([0-9a-f]{12,64})\.(final|committed|used)$/;

/**
 * Human-side retention: moves terminal (never-again-consumable) requests that were created AND expired more
 * than `olderThanDays` days ago into <state dir>/archive/. Requiring expiry as well as age covers records made by
 * older versions without the 7-day TTL cap: an archived approval is always past its deadline, and consume
 * re-checks the record after its claim, so nothing archived can be decided or consumed. The .json record moves
 * first: a crash part-way leaves orphan markers, which read as "not found" (fail closed) and are moved by the next
 * run, as is a file left in both places by a crash between link and unlink. A marker written for an id after it was
archived stays in requests/ (it reads as "not found"). Entries are streamed, so this works at any directory size.
Nothing in archive/ is ever replaced.
 */
export async function archiveRequests(olderThanDays = 30): Promise<number> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 8 || olderThanDays > 36_500) {
    throw new Error("olderThanDays must be an integer from 8 to 36500");
  }
  await ensureDirs();
  const archive = path.join(gateDir(), "archive");
  await fs.mkdir(archive, { recursive: true, mode: 0o700 });
  await securePath(archive, "dir", 0o700);
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
  let moved = 0;
  for await (const name of streamEntries()) {
    const orphan = MARKER_FILE_RE.exec(name);
    if (orphan) {
      const id = orphan[1];
      if (!(await exists(requestPath(id))) && (await exists(path.join(archive, `${id}.json`)))) {
        await moveNoClobber(path.join(requestsDir(), name), path.join(archive, name));
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const view = await getRequest(id);
    if (!view || !TERMINAL.has(view.effectiveStatus) || !(Date.parse(view.createdAt) <= cutoff) || !isPastExpiry(view, cutoff)) continue;
    if (!(await moveNoClobber(requestPath(id), path.join(archive, name)))) continue;
    for (const kind of ["final", "committed", "used"] as const) {
      await moveNoClobber(markerPath(id, kind), path.join(archive, `${id}.${kind}`));
    }
    moved++;
  }
  await audit("archived", { count: moved, olderThanDays });
  return moved;
}

/** Best-effort: make an approval permanently unusable. */
async function invalidate(id: string, why: string): Promise<void> {
  await claimMarker(markerPath(id, "used"), `invalidated:${why}`).catch(() => {});
}

/** Revoke an approved, not-yet-consumed approval. Linearized against consumption by the .used marker. */
export async function revokeApproval(id: string, reason?: string): Promise<RequestView> {
  if (!isValidId(id)) throw new Error("No request with that id (invalid id format)");
  if (reason !== undefined) boundedText(reason, "decision reason", LIMITS.reason, false);
  const req = await reconciled(id);
  if (!req) throw new Error(`No request with id ${id}`);
  if (req.status !== "approved") throw new Error(`Request ${id} is ${req.status}, not approved`);
  if (!(await claimMarker(markerPath(id, "used"), "revoked"))) {
    throw new Error(`Request ${id} is already ${await effective(req)}`);
  }
  const revoked = { ...req, revokedAt: new Date().toISOString() };
  // The .used marker is the record of revocation. A long-expired approval may be an archive candidate, so its
  // JSON file is not rewritten (that could recreate an archived record; re-audit RA-AG-02).
  if (!isPastExpiry(req)) await writeRequest(revoked).catch(() => {});
  await audit("revoked", { id, action: req.action, reason }).catch(() => {});
  return { ...revoked, effectiveStatus: "revoked", authorizesExecution: false };
}

export async function decide(id: string, approve: boolean, reason?: string): Promise<RequestView> {
  if (!isValidId(id)) throw new Error("No request with that id (invalid id format)");
  if (typeof approve !== "boolean") throw new Error("approve must be a boolean");
  if (reason !== undefined) boundedText(reason, "decision reason", LIMITS.reason, false);
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
    await audit("expired", { id, action: req.action }).catch(() => {});
    throw new Error(`Request ${id} is already expired`);
  }
  const decided: ApprovalRequest = { ...req, status, decidedAt: new Date().toISOString(), decisionReason: reason };
  try {
    await writeRequest(decided);
    await audit(status, { id, action: req.action, reason, operation: req.operation, payloadDigest: req.payloadDigest });
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

export interface ConsumeGrant {
  readonly ok: true;
  readonly id: string;
  readonly action: string;
  readonly operation?: string;
  readonly payloadDigest?: string;
  readonly payloadCanonical?: string;
  readonly consumedAt: string;
  readonly expiresAt: string;
}

export type ConsumeResult = ConsumeGrant | { ok: false; error: string; effectiveStatus?: EffectiveStatus };

/**
 * Grants issued by consumeApproval in THIS process, by object identity. A copy, a JSON round trip
 * (an MCP response, a file, an agent message) or a hand-built object is never in this set.
 */
const issuedGrants = new WeakSet<object>();

/**
 * The only operation that authorizes execution. Succeeds at most once per request, only if: the
 * decision is approved and committed (audit persisted), `action` matches exactly, the presented
 * binding (operation, payload) equals what was approved, the exclusive .used claim is won, and the
 * clock read after the claim AND after all awaited persistence is <= expiresAt. Refusals after the
 * claim keep the .used marker, so a refused approval can never be retried or replayed.
 */
export async function consumeApproval(id: string, action: string, binding: Binding = {}): Promise<ConsumeResult> {
  boundedText(action, "action", LIMITS.action);
  if (!isValidId(id)) return { ok: false, error: "not_found" };
  const req = await reconciled(id);
  if (!req) return { ok: false, error: "not_found" };
  const eff = await effective(req);
  if (eff !== "approved_unconsumed") return { ok: false, error: "not_usable", effectiveStatus: eff };
  if (action !== req.action) return { ok: false, error: "action_mismatch", effectiveStatus: eff };
  const mismatch = bindingError(req, binding);
  if (mismatch) return { ok: false, error: mismatch, effectiveStatus: eff };
  const claimedAt = new Date().toISOString();
  if (!(await claimMarker(markerPath(id, "used"), `consume-claimed ${claimedAt}`))) {
    return { ok: false, error: "already_used", effectiveStatus: await effective(req) };
  }
  // The record must still be the one checked above: not archived, replaced or re-decided while we claimed.
  const now = await readRaw(id);
  const same = now !== undefined && (["action", "createdAt", "expiresAt", "operation", "payloadDigest"] as const).every((k) => now[k] === req[k]);
  if (!same || (await readMarker(id, "final")) !== "approved" || (await readMarker(id, "committed")) !== "committed") {
    await audit("consume_rejected_changed", { id }).catch(() => {});
    return { ok: false, error: "not_usable" };
  }
  // Check-vs-use: expiry is evaluated after the exclusive claim, so no approval is usable past its deadline.
  if (isPastExpiry(req)) {
    await audit("consume_rejected_expired", { id, phase: "after_claim" }).catch(() => {});
    return { ok: false, error: "approval_expired", effectiveStatus: "consumed" };
  }
  try {
    await writeRequest({ ...req, consumedAt: claimedAt });
    await audit("consumed", { id, action, operation: req.operation, payloadDigest: req.payloadDigest });
  } catch {
    // The approval is already burned (.used claimed); refuse rather than authorize without an audit record.
    return { ok: false, error: "audit_failed", effectiveStatus: "consumed" };
  }
  // Persistence can cross the deadline after the post-claim check. The marker stays burned.
  if (isPastExpiry(req)) {
    await audit("consume_rejected_expired", { id, phase: "after_persistence" }).catch(() => {});
    return { ok: false, error: "approval_expired", effectiveStatus: "consumed" };
  }
  const grant: ConsumeGrant = Object.freeze({
    ok: true as const,
    id,
    action,
    operation: req.operation,
    payloadDigest: req.payloadDigest,
    payloadCanonical: req.payloadCanonical,
    consumedAt: claimedAt,
    expiresAt: req.expiresAt,
  });
  issuedGrants.add(grant);
  return grant;
}

/**
 * Throws unless `result` is a grant that consumeApproval issued in this same process, presented here
 * for the first time, for exactly this id, action and binding, and still unexpired. Each grant is
 * accepted at most once (it is burned on first presentation, even if a check then fails).
 *
 * It deliberately cannot accept anything that crossed a process boundary: a result received over MCP,
 * read from a file or handed over by an agent is never authority, however well-formed. Prefer
 * executeApproved, which consumes and checks in one step.
 */
export function assertConsumed(result: unknown, id: string, action: string, binding: Binding = {}): void {
  if (typeof result !== "object" || result === null || !issuedGrants.delete(result)) {
    throw new Error("not authorized: only a grant issued by consumeApproval in this process is accepted, once; receipts from MCP, files or agents are never authority");
  }
  const grant = result as ConsumeGrant;
  if (grant.id !== id || grant.action !== action) throw new Error("not authorized: grant is for a different request or action");
  const mismatch = bindingError(grant, binding);
  if (mismatch) throw new Error(`not authorized: ${mismatch}`);
  if (isPastExpiry(grant)) throw new Error("not authorized: approval expired");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export interface ExecutionBinding extends Binding {
  /** Exact approved action text. */
  action: string;
}

export interface ExecutionContext {
  readonly id: string;
  readonly action: string;
  readonly operation?: string;
  /** Deep-frozen copy of the APPROVED payload (parsed from the stored canonical bytes). Execute this, nothing else. */
  readonly payload?: unknown;
  readonly payloadDigest?: string;
  readonly expiresAt: string;
  /** Throws if the approval has expired. Call it again immediately before any side effect that follows an await. */
  assertActive(): void;
}

/**
 * Trusted-code execution boundary. It accepts no receipt: it performs the authoritative single-use
 * consume itself, bound to the action text and (if approved with them) the operation and the canonical
 * payload; records `execution_started` (fsync); re-checks expiry; then invokes `execute` synchronously,
 * with no await between that last clock read and the call.
 *
 * Crash/replay semantics: once consume succeeds the approval is spent, whatever happens next. If the
 * start record cannot be written, nothing is executed. If the process dies after `execution_started`
 * and before `execution_finished`, the outcome is unknown and the approval is NOT reusable: a human must
 * inspect the external system and, if needed, approve a new request. There is no atomicity between this
 * gate's state and the external system the callback touches.
 *
 * This is a local, same-user safeguard. It does not authenticate the human or isolate the agent; see the
 * README threat model for what a separately trusted executor would still require.
 */
export async function executeApproved<T>(
  id: string,
  binding: ExecutionBinding,
  execute: (context: ExecutionContext) => T | Promise<T>,
): Promise<T> {
  if (typeof execute !== "function") throw new Error("execute must be a function supplied by trusted code");
  if (!binding || typeof binding !== "object") throw new Error("binding must be an object with the exact approved action");
  const result = await consumeApproval(id, binding.action, binding);
  if (!result.ok) throw new Error(`not authorized: ${result.error}`);
  assertConsumed(result, id, binding.action, binding);
  const payload = result.payloadCanonical === undefined ? undefined : deepFreeze(JSON.parse(result.payloadCanonical));
  try {
    await audit("execution_started", { id, operation: result.operation, payloadDigest: result.payloadDigest });
  } catch {
    throw new Error("not authorized: execution start could not be recorded; the approval is spent and nothing was executed");
  }
  const assertActive = () => {
    if (isPastExpiry(result)) throw new Error("not authorized: approval expired before execution");
  };
  const context: ExecutionContext = Object.freeze({
    id,
    action: result.action,
    operation: result.operation,
    payload,
    payloadDigest: result.payloadDigest,
    expiresAt: result.expiresAt,
    assertActive,
  });
  try {
    assertActive(); // after the last awaited persistence; nothing is awaited between here and the call
  } catch (err) {
    await audit("execution_refused", { id, reason: "approval_expired" }).catch(() => {});
    throw err;
  }
  let outcome = "threw";
  try {
    const value = await execute(context);
    outcome = "returned";
    return value;
  } finally {
    await audit("execution_finished", { id, outcome }).catch(() => {});
  }
}
