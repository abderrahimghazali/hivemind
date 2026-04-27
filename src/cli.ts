#!/usr/bin/env bun

import { runInit } from "./cli/init";
import { runClaude } from "./cli/claude";
import { runCodex } from "./cli/codex";
import { runKill } from "./cli/kill";
import { runStatus } from "./cli/status";
import { runLogs } from "./cli/logs";
import { runDev } from "./cli/dev";

const USAGE = `Hivemind — bridge Claude Code and Codex on one machine.

Usage:
  hm init                     Register the Hivemind plugin in Claude Code
  hm claude                   Launch Claude Code with the Hivemind plugin enabled
  hm codex                    Launch Codex TUI wired to the Hivemind daemon
  hm status                   Show daemon health and Codex connection state
  hm logs [-f]                Tail the Hivemind log file (-f to follow)
  hm kill                     Stop the daemon and write a killed sentinel
  hm dev                      Run the daemon in the foreground for development

Environment:
  HIVEMIND_CONTROL_PORT       Control port for daemon ↔ bridge (default 4602)
  HIVEMIND_STATE_DIR          Override state directory
`;

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  switch (subcommand) {
    case "init":   return runInit(rest);
    case "claude": return runClaude(rest);
    case "codex":  return runCodex(rest);
    case "status": return runStatus(rest);
    case "logs":   return runLogs(rest);
    case "kill":   return runKill(rest);
    case "dev":    return runDev(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`hm: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
