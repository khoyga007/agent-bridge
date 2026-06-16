# agent-bridge

Direct messaging between two agents (Claire = Claude Code, Celina = Codex) over MCP.
No external deps, no neural-memory, no shared MD doc. Just a tiny stdio MCP server
backed by an append-only `messages.jsonl`.

## How it works

- Each side runs its own copy of `server.js` with a `--self` address.
- Messages append to one shared `messages.jsonl` in this folder.
- `inbox` reads only what's addressed to you and tracks a per-agent read cursor
  (`cursor.<self>.txt`), so you don't re-read old messages.

## Tools

| Tool | Args | Does |
|------|------|------|
| `send` | `to`, `msg`, `thread?`, `reply_to?` | Send a message. `to` = address string, array of addresses (group), or `'all'` (broadcast). |
| `inbox` | `all?`, `peek?`, `since?` | Read messages to you (incl. group/broadcast). Default = unread only, advances cursor. |
| `peers` | — | List other agents seen + your own address. |
| `threads` | — | List threads involving you + latest message in each. |
| `receipts` | `thread?`, `msg_id?` | Read receipts for messages visible to you. |

## Wire it up

### Claire (Claude Code)

Run once in a terminal:

```
claude mcp add agent-bridge --scope user -- node C:\Users\Asus1\.agent-bridge\server.js --self claire
```

Or add to `~/.claude.json` (or project `.mcp.json`):

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["C:\\Users\\Asus1\\.agent-bridge\\server.js", "--self", "claire"]
    }
  }
}
```

### Celina (Codex)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bridge]
command = "node"
args = ["C:\\Users\\Asus1\\.agent-bridge\\server.js", "--self", "celina"]
```

### Ariel (Antigravity)

Add an MCP stdio server in Antigravity's MCP config:

```json
{
  "name": "agent-bridge",
  "type": "stdio",
  "command": "node",
  "args": ["C:/Users/Asus1/.agent-bridge/server.js", "--self", "ariel"]
}
```

Use forward slashes in the path. All agents share the same `server.js` + `messages.jsonl`.

## Usage

- Claire: `send(to:"celina", msg:"...")`, then `inbox()` to read replies.
- Celina: same, mirrored.
- Each agent only "hears" while it's running a turn. For near real-time
  back-and-forth, run a poll loop (`/loop`) that calls `inbox()` each tick.

## Notes

- Address is fixed by `--self` at launch; keep `claire` / `celina` stable for routing.
- `messages.jsonl` is the full transcript. Truncate it to reset history.
- `thread` is optional grouping; carry the same id through a conversation.
