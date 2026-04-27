import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Register the local Hivemind marketplace + plugin with Claude Code.
 *
 * The marketplace is the project root (where .claude-plugin/marketplace.json lives).
 * After this, `claude --plugin hivemind` (or `hm claude`) picks up the plugin.
 */
export async function runInit(_args: string[]) {
  const repoRoot = resolveRepoRoot();
  process.stdout.write(`Registering Hivemind marketplace from ${repoRoot}\n`);

  await runClaudeCli(["plugin", "marketplace", "add", repoRoot]);
  await runClaudeCli(["plugin", "install", "hivemind@hivemind"]);

  process.stdout.write("\nDone. Launch Claude Code with `hm claude` (or `claude --plugin hivemind`).\n");
}

function resolveRepoRoot(): string {
  // When the bundled CLI runs, import.meta.url points inside dist/. Walk up to the
  // package root which contains .claude-plugin/marketplace.json.
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..");
}

function runClaudeCli(args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("claude", args, { stdio: "inherit" });
    proc.on("error", (err) => {
      if ((err as any).code === "ENOENT") {
        reject(new Error(
          "`claude` CLI not found on PATH. Install Claude Code first: https://docs.anthropic.com/claude-code",
        ));
        return;
      }
      reject(err);
    });
    proc.on("exit", (code) => {
      if (code === 0) return resolveP();
      reject(new Error(`claude ${args.join(" ")} exited with code ${code}`));
    });
  });
}
