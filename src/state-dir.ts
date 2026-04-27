import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Resolves the runtime state directory for Hivemind.
 *
 * macOS:  ~/Library/Application Support/Hivemind
 * Linux:  ${XDG_STATE_HOME:-~/.local/state}/hivemind
 * Override: HIVEMIND_STATE_DIR env var
 */
export class StateDir {
  readonly dir: string;

  constructor(envOverride?: string) {
    const override = envOverride ?? process.env.HIVEMIND_STATE_DIR;
    if (override) {
      this.dir = override;
    } else if (platform() === "darwin") {
      this.dir = join(homedir(), "Library", "Application Support", "Hivemind");
    } else {
      const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
      this.dir = join(xdg, "hivemind");
    }
  }

  ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  get pidFile() { return join(this.dir, "daemon.pid"); }
  get lockFile() { return join(this.dir, "daemon.lock"); }
  get statusFile() { return join(this.dir, "status.json"); }
  get logFile() { return join(this.dir, "hivemind.log"); }
  get killedFile() { return join(this.dir, "killed"); }
}
