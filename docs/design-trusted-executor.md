# Design: canonical-payload trusted executor

Status (0.4.0-rc.1): steps 1, 2 and the consume/expiry part of step 4 are implemented **in-process**:
requests can bind an `operation` and an RFC 8785 canonical JSON `payload` (SHA-256 digest), the CLI
shows them to the human, and `executeApproved` consumes, re-checks expiry and hands the trusted
function a frozen copy of the approved payload. Steps 3, 5 and 6 (a separate executor identity
holding the capability, human authentication, tamper-evident audit) are **not implemented** and
create no credentials. Without them a same-user agent can still bypass the gate.

## Problem

Without a payload, the binding is *cooperative*: `consume_approval(id, action)` matches the free-text
`action` string the agent wrote. The agent that performs the side effect is the same party that wrote the
text, so nothing forces the executed payload (the email body, the SQL, the deploy target) to equal
what the human read. A same-user agent can also bypass the gate entirely (README, Threat model).

## Separation

| Layer | Who enforces | Guarantee |
|---|---|---|
| Cooperative protocol | The agent's own policy | Single-use, action-text-bound, expiring approvals, *if the agent calls the gate* |
| In-process binding (implemented) | Trusted code calling `executeApproved` | The payload handed to the function equals the approved canonical payload, *if that code is not the agent and uses it* |
| Enforced binding (proposed) | A separate executor process the agent cannot impersonate | The executed payload equals the approved payload byte for byte, even against a same-user agent |

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
