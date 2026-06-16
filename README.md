# agent-bridge

A minimal, zero-dependency MCP stdio relay that lets multiple AI agents coordinate
through a single shared, append-only log. No broker, no database, no daemon — just a
tiny `server.js` per agent backed by `messages.jsonl`.

Each agent runs its own copy of the server with a distinct `--self` address. All
copies read and write the same files in the store directory, so coordination is
just file I/O.

## Features

- **Messaging** — `send` / `inbox` / `sync` with per-agent byte-offset read cursors, threads, and receipts.
- **Log rotation + prune** — generation-based rotation when the log grows past a size/line limit, plus safe pruning of generations every agent has already consumed.
- **Task claim** — `task` / `claim` / `renew` / `result` / `requeue` with effectively-once semantics enforced by a deterministic, log-order reducer (no wall-clock arbitration).
- **Structured reviews** — `review` / `reviews` record verdicts (`approve` / `request_changes`) with file-level issues.
- **Advisory file locks** — `flock` / `funlock` / `flocks` so agents don't clobber each other's edits.
- **Role-based gating** — optional `roles.json` policy that restricts which agent may perform which action. Enforced both at append time and inside the reducer (unauthorized records are dropped from derived state), so a non-compliant client can't corrupt shared state.

## Quick start

Each agent registers the server with its own address. Examples for three agents
addressed `planner`, `executor`, and `qa`:

```
# Claude Code
claude mcp add agent-bridge --scope user -- node /path/to/agent-bridge/server.js --self planner
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.agent-bridge]
command = "node"
args = ["/path/to/agent-bridge/server.js", "--self", "executor"]
```

```json
// Generic MCP stdio config
{
  "name": "agent-bridge",
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/agent-bridge/server.js", "--self", "qa"]
}
```

`--self <name>` is the agent's address and is required. `--store <dir>` overrides the
store directory (defaults to the server's own folder). Use forward slashes in paths.

## Tools

| Tool | Args | Description |
|------|------|-------------|
| `send` | `to`, `msg`, `thread?`, `reply_to?` | Send a message. `to` = address string, array (group), or `'all'` (broadcast). |
| `inbox` | `all?`, `limit?`, `peek?`, `since?` | Read messages addressed to you. Default = unread only (limit 20), advances cursor. |
| `sync` | `outbox?`, `limit?`, `peek?` | Append messages then read inbox in one round trip. |
| `peers` | — | List agents seen plus your own address. |
| `threads` | — | List threads involving you with the latest message in each. |
| `receipts` | `thread?`, `msg_id?` | Read receipts for messages visible to you. |
| `task` | `spec_hash`, `task_id?`, `msg?`, `requires_human?` | Append a task record. |
| `claim` | `task_id`, `epoch?`, `lease_seconds?` | Claim a task epoch. First claim in log order wins. |
| `renew` | `task_id`, `epoch?`, `lease_seconds?` | Extend your lease on a claimed task. |
| `result` | `task_id`, `epoch?`, `result_hash?` | Record a task result (idempotent). |
| `requeue` | `task_id`, `from_epoch?` | Bump a stale task to a new epoch for reclaiming. |
| `review` | `target`, `verdict`, `issues?`, `msg?` | Append a structured review verdict. |
| `reviews` | `target?` | List review verdict records. |
| `flock` | `path`, `ttl?` | Acquire an advisory lock on a file path. |
| `funlock` | `path` | Release a lock you hold. |
| `flocks` | — | List active locks. |
| `prune` | — | Delete rotated generations every live cursor has passed. |

## Viewer dashboard

A zero-dependency local web dashboard to read the message feed and issue coordinator actions:

```
node viewer.js --port 8787 --self planner
```

Then open `http://127.0.0.1:8787`. It reads the log directly for display (threads, task state,
per-agent filtering, auto-refresh) and forwards coordinator buttons (create task, requeue, approve /
request changes, send message) to a real `server.js` subprocess over MCP JSON-RPC, so all locking and
log formatting is reused. Actions are recorded under the `--self` identity (default `planner`).

## Configuration

- `state.json` (auto-created): `max_lines`, `max_bytes` rotation triggers, `current_gen`, and `max_backlog` (prune escape hatch; `0` = off).
- `roles.json` (optional): `policy_mode` (`off` / `advisory` / `enforce`), `active_preset`, and per-agent action grants. If missing or invalid, policy is off (fail-open). See `presets/` for example role sets.

## Design notes

- Single shared append-only log; readers track an absolute byte offset per generation.
- Task arbitration is by **log order**, not wall-clock — the reducer is pure and deterministic, so every agent derives identical state from the same log.
- Role gating is a **workflow guardrail, not a security boundary.** It prevents accidental out-of-role actions; it does not defend against a malicious process that writes the log directly.

## Tests

```
npm test
```

Runs the full suite (`run-tests.js`): reducer, rotation, task-claim, sync, review, flock, and policy.
