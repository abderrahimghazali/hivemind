#!/usr/bin/env bun

import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { ClaudeMcpServer } from "./claude-mcp";
import { StateDir } from "./state-dir";
import { makeLogger } from "./log";

const stateDir = new StateDir();
stateDir.ensure();
const log = makeLogger("HivemindBridge", stateDir.logFile);

const CONTROL_PORT = parseInt(process.env.HIVEMIND_CONTROL_PORT ?? "4602", 10);
const lifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

if (lifecycle.wasKilled()) {
  log("Killed sentinel present — bridge will refuse MCP work until cleared (run `hm codex`).");
  process.stderr.write(
    "Hivemind is paused. Run `hm codex` to clear the killed sentinel and relaunch the daemon.\n",
  );
  process.exit(0);
}

const client = new DaemonClient({ url: lifecycle.controlWsUrl, log: makeLogger("DaemonClient", stateDir.logFile) });
const mcp = new ClaudeMcpServer(client, makeLogger("McpServer", stateDir.logFile));

client.on("codexMessage", (msg) => mcp.pushMessage(msg));
client.on("replaced", () => {
  log("Replaced by another bridge — exiting.");
  shutdown(0);
});
client.on("disconnected", () => {
  log("Daemon disconnected — exiting bridge to let MCP host respawn it.");
  shutdown(1);
});

mcp.on("ready", async () => {
  try {
    await lifecycle.ensureRunning();
    await client.connect();
    log("Bridge online — MCP attached to daemon");
  } catch (err: any) {
    log(`Failed to bring up daemon link: ${err.stack ?? err.message}`);
    process.stderr.write(`Hivemind bridge failed: ${err.message}\n`);
    shutdown(1);
  }
});

let shuttingDown = false;
function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { client.disconnect(); } catch {}
  void mcp.stop().finally(() => process.exit(code));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => log(`UNCAUGHT: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (reason: any) => log(`UNHANDLED: ${reason?.stack ?? reason}`));

void mcp.start();
