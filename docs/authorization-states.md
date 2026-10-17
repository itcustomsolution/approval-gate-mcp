# Authorization states and revocation

Files per request in `requests/`: `<id>.json` (descriptive record), plus one-time markers created
with link(2) so they are complete when visible and only one writer can create each:

| Marker | Content | Meaning |
|---|---|---|
| `<id>.final` | `approved` / `denied` / `expired` | The single terminal decision. **Authoritative** over `<id>.json`. |
| `<id>.committed` | `committed` | Written only after the approval's JSON record **and** audit line were persisted (fsync). |
| `<id>.used` | `consume-claimed <iso>` / `revoked` / `invalidated:<why>` | The single use-or-kill transition for an approval. |

A request may also carry an `operation` name and a `payloadCanonical` (RFC 8785 canonical JSON) with
its SHA-256 `payloadDigest`. A record whose canonical payload does not hash to its digest is treated
as missing (fail closed).

## Transitions

```
pending ──approve (now ≤ expiresAt at claim)──▶ approved, uncommitted ──JSON+audit ok──▶ approved, committed
pending ──approve (now > expiresAt at claim)──▶ expired
pending ──deny───────────────────────────────▶ denied
pending ──read after expiresAt───────────────▶ expired
approved, committed ──consume: action and binding match, wins .used, now ≤ expiresAt after the claim
                      AND after the JSON/audit writes──▶ consumed (ok:true, once)
approved, committed ──consume: wins .used but now > expiresAt (after claim or after persistence)──▶ burned, ok:false approval_expired
approved, committed ──consume: action/operation/payload differ──▶ unchanged, ok:false *_mismatch / *_not_bound
approved, * ──revoke (CLI `revoke`, or `deny` / MCP decide_approval approve:false)──▶ revoked
approved, * ──JSON or audit write fails during approve──▶ invalidated
```

An approval authorizes execution **iff** a consume succeeds: `consumeApproval` returns `ok: true`
(once), or `executeApproved` reaches the caller's function. Everything else (`status: "approved"`,
`effectiveStatus: "approved_unconsumed"`, a timeout, a consume result received over MCP) is
informational.

## When an approval is valid

An approval is valid at time *t* iff *t* ≤ `expiresAt`, on this host's clock. `consumeApproval`
returns ok:true only if the clock read after winning `.used` and the clock read after the record and
audit writes both satisfy that. `executeApproved` then writes `execution_started` and checks the
clock again immediately before calling the function, with no `await` in between. Work the function
does after its own awaits must call `ctx.assertActive()` again before the side effect. The gate
cannot bound how long an external call takes once started, and it trusts the host clock.

## executeApproved: crash and replay semantics

| Point | Result |
|---|---|
| Binding (action/operation/payload) mismatch | Refused before the claim; the approval is unchanged. |
| Lost the `.used` race | `already_used`; nothing runs. Exactly one consumer wins, across processes. |
| Consume refused after the claim (expired, audit failed) | Approval spent; nothing runs; never retried. |
| `execution_started` write fails | Approval spent; nothing runs. |
| Expired during the `execution_started` write | `execution_refused` audited; approval spent; nothing runs. |
| Function returns or throws | `execution_finished` audited (`returned` / `threw`), best effort. |
| Process dies after `execution_started` | `execution_started` without `execution_finished`: outcome unknown. The approval stays spent; inspect the external system and, if needed, approve a new request. |

There is no atomic transaction across this gate's files and the external system. The gate never
retries an execution.

## Revocation semantics

- A human (or the agent, since revoking only removes authority) may revoke an approved,
  unconsumed request. Revoke and consume race on the same `.used` marker: exactly one wins.
- Revocation after a successful consume fails: the action may already be under way. Revocation
  cannot recall an action; it only prevents a future consume.
- Expiry is checked again after the `.used` claim and after persistence, so no consume can succeed
  past `expiresAt`.

## Failure and crash behaviour (fail closed)

| Crash / failure point | Result |
|---|---|
| After `.final=approved`, before JSON/audit | `approved_uncommitted`: never consumable. Create a new request. |
| JSON or audit write throws during approve | `.used=invalidated:decision_write_failed` best effort; without `.committed` it is unusable anyway. |
| After `.final=denied`, before JSON | Reads as `denied` (marker wins). |
| `requested` audit write fails | No request file is written; there is nothing to approve. |
| Crash after the `requested` audit line, before the request file | An audit line for a request that never existed; nothing to approve. The audit line is always written first. |
| After `.used` claim, audit throws during consume | `ok:false audit_failed`; approval burned. |
| Orphan `*.tmp` files | Ignored; never treated as markers. |
| JSON says approved/denied/expired with no `.final` | Read as `denied` (hand edit or corruption). |

## Archive

`approval-gate archive [--older-than-days N]` (N ≥ 8, default 30) moves terminal requests
(denied, expired, consumed, revoked, invalidated, approved but expired or uncommitted) that were created
**and** expired at least N days ago into `archive/`. Requiring expiry covers records written by versions
before the 7-day TTL cap: an archived approval is always past its deadline. Consume also re-reads the record
and its markers after winning `.used`, so a record moved or replaced during the claim is refused and stays
spent. The `.json` record moves first, so a crash part-way leaves only orphan markers, which read as "not
found" and are moved by the next run. Each move is a hard link followed by removing the original; a crash between
the two leaves the same file in both places, and the next run completes the move. Nothing in `archive/` is ever
replaced, so a marker written for an id after it was archived stays in `requests/` (it reads as "not found"). Pending and
approved-unconsumed requests are never archived.

An existing marker that cannot be read (too large, wrong type, no permission, empty) counts as a decision
that matches no state: the request reads as denied and an approval as unusable.
