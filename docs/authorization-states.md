# Authorization states and revocation

Files per request in `requests/`: `<id>.json` (descriptive record), plus one-time markers created
with link(2) so they are complete when visible and only one writer can create each:

| Marker | Content | Meaning |
|---|---|---|
| `<id>.final` | `approved` / `denied` / `expired` | The single terminal decision. **Authoritative** over `<id>.json`. |
| `<id>.committed` | `committed` | Written only after the approval's JSON record **and** audit line were persisted (fsync). |
| `<id>.used` | `consume-claimed <iso>` / `revoked` / `invalidated:<why>` | The single use-or-kill transition for an approval. |

## Transitions

```
pending ──approve (now ≤ expiresAt at claim)──▶ approved, uncommitted ──JSON+audit ok──▶ approved, committed
pending ──approve (now > expiresAt at claim)──▶ expired
pending ──deny───────────────────────────────▶ denied
pending ──read after expiresAt───────────────▶ expired
approved, committed ──consume: wins .used AND now ≤ expiresAt (read after the claim) AND action matches──▶ consumed (ok:true, once)
approved, committed ──consume: wins .used but now > expiresAt──▶ burned, ok:false approval_expired
approved, * ──revoke (CLI `revoke`, or `deny` / MCP decide_approval approve:false)──▶ revoked
approved, * ──JSON or audit write fails during approve──▶ invalidated
```

An approval authorizes execution **iff** `consumeApproval` returns `ok: true`. Everything else
(`status: "approved"`, `effectiveStatus: "approved_unconsumed"`, a timeout) is informational.

## Revocation semantics

- A human (or the agent, since revoking only removes authority) may revoke an approved,
  unconsumed request. Revoke and consume race on the same `.used` marker: exactly one wins.
- Revocation after a successful consume fails: the action may already be under way. Revocation
  cannot recall an action; it only prevents a future consume.
- Expiry is checked again after the `.used` claim, so no consume can succeed past `expiresAt`.

## Failure and crash behaviour (fail closed)

| Crash / failure point | Result |
|---|---|
| After `.final=approved`, before JSON/audit | `approved_uncommitted`: never consumable. Create a new request. |
| JSON or audit write throws during approve | `.used=invalidated:decision_write_failed` best effort; without `.committed` it is unusable anyway. |
| After `.final=denied`, before JSON | Reads as `denied` (marker wins). |
| After `.used` claim, audit throws during consume | `ok:false audit_failed`; approval burned. |
| Orphan `*.tmp` files | Ignored; never treated as markers. |
| JSON says approved/denied/expired with no `.final` | Read as `denied` (hand edit or corruption). |
