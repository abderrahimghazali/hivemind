import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StateDir } from "../state-dir";

export async function runLogs(args: string[]) {
  const stateDir = new StateDir();
  stateDir.ensure();
  const file = stateDir.logFile;
  if (!existsSync(file)) {
    process.stdout.write(`No log file at ${file} yet.\n`);
    return;
  }
  const follow = args.includes("-f") || args.includes("--follow");
  const tailArgs = follow ? ["-f", file] : ["-n", "200", file];
  const proc = spawn("tail", tailArgs, { stdio: "inherit" });
  proc.on("exit", (code) => process.exit(code ?? 0));
}
