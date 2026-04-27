import { StateDir } from "../state-dir";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { makeLogger } from "../log";

const CONTROL_PORT = parseInt(process.env.HIVEMIND_CONTROL_PORT ?? "4602", 10);

/**
 * Stop the daemon (SIGTERM, then SIGKILL if it doesn't exit) and write the
 * killed sentinel so subsequent bridge launches refuse to start until `hm codex`
 * clears it.
 */
export async function runKill(_args: string[]) {
  const stateDir = new StateDir();
  stateDir.ensure();
  const log = makeLogger("HmKill", stateDir.logFile);
  const lifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

  const killed = await lifecycle.kill();
  lifecycle.markKilled();

  if (killed) {
    process.stdout.write("Hivemind daemon stopped. Run `hm codex` to relaunch.\n");
  } else {
    process.stdout.write("Hivemind daemon was not running. Killed sentinel written.\n");
  }
}
