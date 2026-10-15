# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic versioning.

## [Unreleased]

### Added
- Package metadata for npm publishing (`repository`, `homepage`, `bugs`, `engines`, `mcpName`, keywords).
- Behavior tests for the approval store (`npm test`, uses built-in `node:test`, no new dependencies).
- One light CI job on pull requests.
- README quickstart, example flow, contributing section.

No runtime behavior changes.

## [0.1.0]

### Added
- Initial MCP server with `request_approval`, `check_approval`, `wait_for_approval`,
  `list_pending`, `decide_approval`.
- `approval-gate` CLI for out-of-band human decisions.
- Default-deny, TTL expiry, append-only audit log in `~/.approval-gate/`.
