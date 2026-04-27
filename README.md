<p align="center">
  <img src="./docs/hivemind-logo.png" alt="Hivemind logo" width="200" />
</p>

<h1 align="center">Hivemind</h1>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <a href="./package.json"><img alt="Version" src="https://img.shields.io/badge/version-0.1.0-green.svg" /></a>
  <a href="https://bun.sh"><img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-fbf0df.svg" /></a>
  <a href="./tsconfig.json"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-1.29-9146FF.svg" /></a>
  <a href="https://docs.anthropic.com/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757.svg" /></a>
  <a href="https://github.com/openai/codex"><img alt="Codex" src="https://img.shields.io/badge/Codex-app--server-10A37F.svg" /></a>
</p>

Bridge [Claude Code](https://docs.anthropic.com/claude-code) and [Codex](https://github.com/openai/codex) on the same machine. Ask Codex for a second opinion, brainstorm across both models, or call Codex directly from Claude — all without copy/pasting.

> **Status:** v0.1. Single-machine, single Claude ↔ single Codex. Pull-only model (Claude initiates). Push-style FYIs from Codex are deferred.

---

## How it works

```
Claude Code  ──MCP──▶  bridge  ──WS──▶  daemon  ──WS proxy──▶  codex app-server
                                            ▲
                                            │  (WS proxy)
                                            ▼
                                       Codex TUI
```

- **bridge** runs as an MCP stdio server inside Claude Code. It exposes `ask_codex`, `wait_for_codex`, `peers`, `get_messages`.
- **daemon** runs detached. It owns the proxy that sits between the Codex TUI and `codex app-server`. The proxy intercepts agent messages and lets Hivemind inject prompts into the live thread.
- The daemon survives across Claude restarts and idle-shuts-down after 60s with no bridge attached.

---

## Install

```bash
git clone https://github.com/abderrahimghazali/hivemind.git
cd hivemind
bun install
bun run build
bun link        # exposes `hm` and `hivemind` on your PATH
```

You'll need `claude` and `codex` already on your `$PATH`.

---

## Usage

In one terminal, launch Codex through the proxy:

```bash
hm codex
```

This boots the daemon (idempotent), spawns `codex app-server`, and launches the Codex TUI pointed at the proxy. Send any message in Codex once — that creates the thread Hivemind can target.

In another terminal, launch Claude with the Hivemind plugin loaded:

```bash
hm claude
```

Now from inside Claude:

| Slash command | What it does |
|---|---|
| `/hivemind:peers` | List connected peers, threads, warnings |
| `/hivemind:second-opinion <question>` | Ask Codex, then summarize Codex's view + Claude's view + a recommendation |
| `/hivemind:brainstorm <topic>` | Three rounds of back-and-forth, then a synthesis |

Or call MCP tools directly in conversation:

> use `mcp__hivemind__ask_codex` with `text: "..."` and `wait_ms: 60000`

### MCP tools

- `ask_codex({ text, wait_ms? })` — inject a prompt into the Codex thread. If `wait_ms > 0`, blocks until the turn completes (or the timeout) and returns the reply. Otherwise returns immediately and the reply arrives via `wait_for_codex`.
- `wait_for_codex({ timeout_ms? })` — block until Codex sends a message, or drain any buffered messages immediately if available.
- `peers({})` — list peer state. Reports `unsupported_session_picker` warning if Codex opened the picker (Hivemind v0.1 only supports fresh sessions).
- `get_messages({})` — non-blocking drain of buffered messages.

---

## Other commands

```bash
hm status        # daemon health, thread id, queue depth
hm logs -f       # tail the daemon log
hm kill          # stop the daemon and write a "killed" sentinel
hm dev           # run the daemon in the foreground (logs to stderr)
```

`hm kill` writes a sentinel that prevents the bridge from auto-relaunching the daemon. `hm codex` clears it.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CODEX_WS_PORT` | `4600` | Port the codex app-server listens on |
| `CODEX_PROXY_PORT` | `4601` | Port the Codex TUI connects to (the Hivemind proxy) |
| `HIVEMIND_CONTROL_PORT` | `4602` | Port the bridge ↔ daemon control channel uses |
| `HIVEMIND_IDLE_SHUTDOWN_MS` | `60000` | Idle timeout before the daemon shuts itself down |
| `HIVEMIND_STATE_DIR` | macOS: `~/Library/Application Support/Hivemind`; Linux: `$XDG_STATE_HOME/hivemind` | Where pid/log/lock live |

---

## Limitations

- **Fresh sessions only.** If Codex opens the session picker (e.g. you launched `codex` directly without `hm codex`, then later attached), Hivemind detects it and `ask_codex` returns `PICKER_DETECTED`. Run `hm kill && hm codex` to reset.
- **One Codex thread at a time.** Multiple TUI connections aren't multiplexed.
- **Pull-only.** Codex can't proactively notify Claude. Claude has to ask.
- **No git writes from Codex.** The bridge contract reminder tells Codex not to run `git commit/push/checkout -b/...` — those hang in the Codex sandbox. Read-only git is fine.

---

## Development

```bash
bun run typecheck    # tsc --noEmit
bun run test         # bun test src
bun run check        # both of the above
bun run build        # bundles dist/cli.js, dist/daemon.js, plugins/hivemind/server/{bridge,daemon}.js
bun run dev          # foreground daemon (or: hm dev)
```

The proxy's protocol logic (`processTuiPayload`, `handleAppServerPayload`, `injectMessage`) is pure with respect to I/O — see `src/codex-proxy.test.ts` for fixture tests covering id rewriting, stale-conn drops, bridge id consumption, inject gates, and agent message extraction.

### Layout

```
src/
  bridge.ts            # foreground entry: MCP server + daemon client
  daemon.ts            # detached entry: control WS + Codex proxy
  codex-proxy.ts       # WS proxy with JSON-RPC id rewriting (the testable core)
  daemon-client.ts     # bridge → daemon WS client
  daemon-lifecycle.ts  # pid/lock/health/spawn
  claude-mcp.ts        # MCP tool definitions and handlers
  control-protocol.ts  # bridge ↔ daemon message types
  codex-protocol.ts    # codex JSON-RPC types + guards
  bridge-contract.ts   # the contract reminder appended to every Claude → Codex message
  cli.ts, cli/*.ts     # `hm` subcommands
plugins/hivemind/      # Claude Code plugin (commands, .mcp.json, bundled server/)
```

---

## License

MIT. See [LICENSE](./LICENSE).
