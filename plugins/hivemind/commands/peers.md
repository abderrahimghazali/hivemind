---
description: Show the state of agents reachable via Hivemind
allowed-tools: mcp__hivemind__peers
---

Call `mcp__hivemind__peers` and present the result as a short status table:

- **Name** — peer identifier (e.g. `codex`)
- **Online** — yes/no
- **Thread** — active Codex thread id, if any
- **Warnings** — any listed warnings, in plain English

If `unsupported_session_picker` appears in warnings, tell the user verbatim:

> Codex's session picker is open. Hivemind v0.1 only supports a single fresh session. Run `hm kill && hm codex` to start cleanly.
