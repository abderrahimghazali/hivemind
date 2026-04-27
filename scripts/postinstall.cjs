#!/usr/bin/env node
// Postinstall: print a hint. Real setup happens via `hm init` or `hm dev`.

const isCi = process.env.CI === "true" || process.env.CI === "1";
if (isCi) process.exit(0);

console.log("");
console.log("Hivemind installed. Next steps:");
console.log("  1) Build:    bun run build");
console.log("  2) Link:     bun link");
console.log("  3) Setup:    hm init     (registers the plugin in Claude Code)");
console.log("  4) Run:      hm claude   (in one terminal)");
console.log("               hm codex    (in another terminal)");
console.log("");
