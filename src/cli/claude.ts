import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Launch Claude Code with the Hivemind plugin enabled via --plugin-dir.
 *
 * --plugin-dir takes the plugin directory itself (one containing
 * .claude-plugin/plugin.json). Extra args are forwarded to `claude`.
 */
export async function runClaude(args: string[]) {
  const pluginDir = resolvePluginDir();
  if (!existsSync(pluginDir)) {
    process.stderr.write(`Hivemind plugin directory not found at ${pluginDir}\n`);
    process.exit(1);
  }
  const proc = spawn("claude", ["--plugin-dir", pluginDir, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  proc.on("error", (err) => {
    if ((err as any).code === "ENOENT") {
      process.stderr.write(
        "`claude` CLI not found on PATH. Install Claude Code first: https://docs.anthropic.com/claude-code\n",
      );
      process.exit(1);
    }
    throw err;
  });
  proc.on("exit", (code) => process.exit(code ?? 0));
}

function resolvePluginDir(): string {
  // dist/cli.js → ../plugins/hivemind, src/cli/claude.ts → ../../plugins/hivemind
  const here = fileURLToPath(new URL(".", import.meta.url));
  const distSibling = resolve(here, "..", "plugins", "hivemind");
  if (existsSync(distSibling)) return distSibling;
  return resolve(here, "..", "..", "plugins", "hivemind");
}
