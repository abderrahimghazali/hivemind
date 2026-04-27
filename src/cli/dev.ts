import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Run the daemon in the foreground for development. Logs go to stderr (and the
 * log file). SIGINT/SIGTERM forward to the child.
 *
 * Resolves `daemon.ts` next to this CLI file (works in dev — `bun run src/cli.ts dev`).
 * The bundled CLI doesn't ship `dev` cleanly because daemon source is gone, so we
 * fall back to `daemon.js` if `daemon.ts` is missing.
 */
export async function runDev(args: string[]) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const tsEntry = resolve(here, "..", "daemon.ts");
  const jsEntry = resolve(dirname(here), "plugins", "hivemind", "server", "daemon.js");
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry;

  const proc = spawn(process.execPath, ["run", entry, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  const forward = (sig: NodeJS.Signals) => () => { try { proc.kill(sig); } catch {} };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  proc.on("exit", (code) => process.exit(code ?? 0));
}
