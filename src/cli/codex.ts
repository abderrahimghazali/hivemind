import { spawn } from "node:child_process";
import { StateDir } from "../state-dir";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { makeLogger } from "../log";

const PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? "4601", 10);
const CONTROL_PORT = parseInt(process.env.HIVEMIND_CONTROL_PORT ?? "4602", 10);

/**
 * Launch the Codex TUI wired to the Hivemind proxy.
 *
 * - Clears the killed sentinel (any prior `hm kill` is intentionally invalidated).
 * - Ensures the daemon is up so the proxy is listening.
 * - Spawns `codex --experimental-client ws://127.0.0.1:<PROXY_PORT>` inheriting stdio.
 *
 * Extra args are forwarded to `codex`.
 */
export async function runCodex(args: string[]) {
  const stateDir = new StateDir();
  stateDir.ensure();
  const log = makeLogger("HmCodex", stateDir.logFile);

  const lifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
  if (lifecycle.wasKilled()) {
    log("Clearing killed sentinel");
    lifecycle.clearKilled();
  }

  await lifecycle.ensureRunning();
  process.stdout.write(`Hivemind daemon ready. Launching Codex TUI → ws://127.0.0.1:${PROXY_PORT}\n`);

  const proc = spawn(
    "codex",
    ["--remote", `ws://127.0.0.1:${PROXY_PORT}`, ...args],
    { stdio: "inherit", env: process.env },
  );
  proc.on("error", (err) => {
    if ((err as any).code === "ENOENT") {
      process.stderr.write(
        "`codex` CLI not found on PATH. Install Codex first: https://github.com/openai/codex\n",
      );
      process.exit(1);
    }
    throw err;
  });
  proc.on("exit", (code) => process.exit(code ?? 0));
}
