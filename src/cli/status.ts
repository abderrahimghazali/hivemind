import { StateDir } from "../state-dir";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { makeLogger } from "../log";

const CONTROL_PORT = parseInt(process.env.HIVEMIND_CONTROL_PORT ?? "4602", 10);

export async function runStatus(_args: string[]) {
  const stateDir = new StateDir();
  stateDir.ensure();
  const log = makeLogger("HmStatus", stateDir.logFile);
  const lifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

  if (lifecycle.wasKilled()) {
    process.stdout.write("State: PAUSED (killed sentinel present — run `hm codex` to clear)\n");
  }

  const pid = lifecycle.readPid();
  const healthy = await lifecycle.isHealthy();
  process.stdout.write(`Daemon PID:   ${pid ?? "(none)"}\n`);
  process.stdout.write(`Healthy:      ${healthy}\n`);
  process.stdout.write(`Health URL:   ${lifecycle.healthUrl}\n`);
  process.stdout.write(`Control WS:   ${lifecycle.controlWsUrl}\n`);

  if (!healthy) return;
  try {
    const res = await fetch(lifecycle.healthUrl);
    const json = await res.json();
    process.stdout.write(`Codex thread: ${json.threadId ?? "(none)"}\n`);
    process.stdout.write(`Codex up:     ${json.codexConnected}\n`);
    process.stdout.write(`Picker seen:  ${json.pickerActive}\n`);
    process.stdout.write(`Queued msgs:  ${json.queuedMessages}\n`);
  } catch (e: any) {
    process.stderr.write(`Could not parse health: ${e.message}\n`);
  }
}
