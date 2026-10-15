# Design proposal: canonical-payload trusted executor (not implemented)

Status: proposal only. Nothing here exists in the package yet, and it adds no credentials.

## Problem

Today the binding is *cooperative*: `consume_approval(id, action)` matches the free-text `action`
string the agent wrote. The agent that performs the side effect is the same party that wrote the
text, so nothing forces the executed payload (the email body, the SQL, the deploy target) to equal
what the human read. A same-user agent can also bypass the gate entirely (README, Threat model).

## Separation

| Layer | Who enforces | Guarantee |
|---|---|---|
| Cooperative protocol (today) | The agent's own policy | Single-use, action-text-bound, expiring approvals, *if the agent calls the gate* |
| Enforced binding (proposed) | A separate executor process the agent cannot impersonate | The executed payload equals the approved payload byte for byte |

## Proposed design

1. **Canonical payload.** The agent submits a structured request
   `{tool, args}` (e.g. `{tool:"smtp.send", args:{to, subject, body}}`). The executor canonicalizes it
   (RFC 8785 JSON Canonicalization Scheme) and computes `digest = SHA-256(canonical)`.
2. **Human review of the canonical form.** The CLI shows the rendered canonical payload (escaped,
   see `display.ts`) and its digest. The decision record binds `{id, digest, expiresAt}`.
3. **Executor holds the capability, the agent does not.** The executor runs as a different OS user
   (or container / service account) and alone holds the credential for the side effect (SMTP
   password, deploy token). The agent's user cannot read the gate state dir or the executor's
   secrets.
4. **Execute-by-reference.** The agent asks the executor to run `id`. The executor re-reads the stored
   canonical payload (not anything the agent re-sends), recomputes the digest, atomically consumes
   the approval (same `.used` claim, expiry re-checked after the claim), writes the audit line, and
   only then performs the call. Any mismatch or failure means no execution.
5. **Human authentication.** Approval is made with a credential the agent does not have, for example a
   signature from a hardware key, an OS-level prompt for a different user, or an approval in a separate
   app. A TTY alone does not authenticate a human.
6. **Tamper-evident audit.** Hash-chain each audit line (`prev_hash`), and optionally ship it off-host.

## Out of scope / open questions

- Choosing the authentication method and key storage. That needs an owner decision and new
  credentials, which this proposal deliberately does not create.
- Per-tool executors versus one generic executor.
- How to render large or binary payloads for review.
