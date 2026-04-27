import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { StateDir } from "./state-dir";
import type { Logger } from "./log";

/**
 * Resolve the daemon entry. Honors HIVEMIND_DAEMON_ENTRY when set, otherwise
 * tries `./daemon.js` (built) and `./daemon.ts` (dev) next to this module.
 * Built bundles live in `dist/`; source lives in `src/`.
 */
function resolveDaemonPath(): string {
  const override = process.env.HIVEMIND_DAEMON_ENTRY;
  if (override) return fileURLToPath(new URL(override, import.meta.url));
  for (const candidate of ["./daemon.js", "./daemon.ts"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  // Last-resort default: same as before, error surfaces clearly when spawned.
  return fileURLToPath(new URL("./daemon.ts", import.meta.url));
}
const DAEMON_PATH = resolveDaemonPath();

export interface DaemonLifecycleOptions {
  stateDir: StateDir;
  controlPort: number;
  log: Logger;
}

/**
 * Manages the daemon process: PID file, lock, killed sentinel, health checks,
 * and detached spawn. Used by both the bridge (to ensure the daemon is up)
 * and the daemon itself (to write its own state).
 */
export class DaemonLifecycle {
  private readonly stateDir: StateDir;
  private readonly controlPort: number;
  private readonly log: Logger;

  constructor(opts: DaemonLifecycleOptions) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
  }

  get healthUrl(): string { return `http://127.0.0.1:${this.controlPort}/healthz`; }
  get controlWsUrl(): string { return `ws://127.0.0.1:${this.controlPort}/ws`; }

  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) return;

    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        if (this.isDaemonProcess(existingPid)) {
          await this.waitForHealthy();
          return;
        }
        this.log(`PID ${existingPid} is alive but not a Hivemind daemon — removing stale pid file`);
      }
      this.removePidFile();
    }

    const acquired = this.acquireLock();
    if (!acquired) {
      this.log("Another launcher holds the lock — waiting for daemon");
      await this.waitForHealthy();
      return;
    }
    try {
      this.launch();
      await this.waitForHealthy();
    } finally {
      this.releaseLock();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(this.healthUrl);
      return res.ok;
    } catch {
      return false;
    }
  }

  async waitForHealthy(maxRetries = 40, delayMs = 250): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Hivemind daemon did not become healthy at ${this.healthUrl}`);
  }

  readPid(): number | null {
    try {
      const raw = readFileSync(this.stateDir.pidFile, "utf-8").trim();
      if (!raw) return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  writePid(pid?: number): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.pidFile, `${pid ?? process.pid}\n`, "utf-8");
  }

  removePidFile(): void {
    try { unlinkSync(this.stateDir.pidFile); } catch {}
  }

  writeStatus(status: Record<string, unknown>): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.statusFile, JSON.stringify(status, null, 2) + "\n", "utf-8");
  }

  removeStatusFile(): void {
    try { unlinkSync(this.stateDir.statusFile); } catch {}
  }

  markKilled(): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.killedFile, `${Date.now()}\n`, "utf-8");
  }

  clearKilled(): void {
    try { unlinkSync(this.stateDir.killedFile); } catch {}
  }

  wasKilled(): boolean {
    return existsSync(this.stateDir.killedFile);
  }

  private launch(): void {
    this.stateDir.ensure();
    this.log(`Launching daemon: ${process.execPath} run ${DAEMON_PATH} (control port ${this.controlPort})`);
    // Pipe daemon stdio to the log file so spawn failures (bad path, missing
    // bun, etc.) surface instead of vanishing into /dev/null.
    const out = openSync(this.stateDir.logFile, "a");
    const proc = spawn(process.execPath, ["run", DAEMON_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HIVEMIND_CONTROL_PORT: String(this.controlPort),
        HIVEMIND_STATE_DIR: this.stateDir.dir,
      },
      detached: true,
      stdio: ["ignore", out, out],
    });
    closeSync(out);
    proc.unref();
  }

  private acquireLock(depth = 0): boolean {
    if (depth > 1) {
      this.log("Lock acquisition failed twice — proceeding without lock");
      return true;
    }
    this.stateDir.ensure();
    try {
      const fd = openSync(
        this.stateDir.lockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      );
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const holder = Number.parseInt(readFileSync(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holder) && !isProcessAlive(holder)) {
            this.log(`Stale lock from dead PID ${holder} — clearing`);
            this.releaseLock();
            return this.acquireLock(depth + 1);
          }
        } catch {
          this.releaseLock();
          return this.acquireLock(depth + 1);
        }
        return false;
      }
      this.log(`Lock error: ${err.message} — proceeding without lock`);
      return true;
    }
  }

  private releaseLock(): void {
    try { unlinkSync(this.stateDir.lockFile); } catch {}
  }

  async kill(timeoutMs = 3000): Promise<boolean> {
    const pid = this.readPid();
    if (!pid) {
      this.cleanup();
      return false;
    }
    if (!isProcessAlive(pid)) {
      this.cleanup();
      return false;
    }
    if (!this.isDaemonProcess(pid)) {
      this.log(`PID ${pid} is alive but not a Hivemind daemon — refusing to kill`);
      this.cleanup();
      return false;
    }
    this.log(`SIGTERM → daemon PID ${pid}`);
    try { process.kill(pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        this.cleanup();
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.log(`SIGKILL → daemon PID ${pid}`);
    try { process.kill(pid, "SIGKILL"); } catch {}
    this.cleanup();
    return true;
  }

  private isDaemonProcess(pid: number): boolean {
    try {
      // -ww disables column truncation, otherwise long install paths get
      // chopped and the includes check below false-negatives.
      const cmd = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
      }).trim();
      return cmd.includes(DAEMON_PATH);
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    this.removePidFile();
    this.removeStatusFile();
    this.releaseLock();
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
