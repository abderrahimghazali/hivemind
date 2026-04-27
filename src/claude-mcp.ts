import { EventEmitter } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClient } from "./daemon-client";
import type { HivemindMessage, PeerInfo } from "./types";
import type { Logger } from "./log";

const MAX_BUFFERED = 200;

interface PendingWait {
  resolve: (msgs: HivemindMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * MCP server exposing Hivemind tools to Claude Code over stdio.
 *
 * Tools:
 *   ask_codex({text, wait_ms?})    — inject prompt; if wait_ms>0, block for the resulting reply
 *   wait_for_codex({timeout_ms?})  — drain buffered messages, or wait for the next one
 *   peers({})                      — list connected peers (just codex for v0.1)
 *   get_messages({})               — non-blocking drain of buffered messages
 */
export class ClaudeMcpServer extends EventEmitter {
  private readonly server: Server;
  private readonly transport = new StdioServerTransport();
  private readonly client: DaemonClient;
  private readonly log: Logger;
  private readonly buffered: HivemindMessage[] = [];
  private waiters: PendingWait[] = [];
  private started = false;

  constructor(client: DaemonClient, log: Logger) {
    super();
    this.client = client;
    this.log = log;
    this.server = new Server(
      { name: "hivemind", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  /** Buffer a Codex message and wake any waiters. Called by bridge.ts on codexMessage. */
  pushMessage(msg: HivemindMessage): void {
    this.buffered.push(msg);
    if (this.buffered.length > MAX_BUFFERED) {
      this.buffered.splice(0, this.buffered.length - MAX_BUFFERED);
    }
    if (this.waiters.length) {
      const drained = this.drainBuffer();
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(drained);
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.server.connect(this.transport);
    this.log("MCP server connected on stdio");
    this.emit("ready");
  }

  async stop(): Promise<void> {
    try { await this.server.close(); } catch {}
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ask_codex",
          description:
            "Send a message to Codex. If wait_ms > 0, blocks until Codex's turn completes (or the timeout) and returns the reply. Otherwise returns immediately and the reply will arrive via wait_for_codex / get_messages.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Prompt for Codex." },
              wait_ms: {
                type: "number",
                description: "How long to block waiting for Codex's reply, in milliseconds. 0 = fire-and-forget. Recommended: 60000–120000 for substantive questions.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "wait_for_codex",
          description:
            "Block until Codex sends a message (or timeout). Returns any buffered messages immediately if available.",
          inputSchema: {
            type: "object",
            properties: {
              timeout_ms: { type: "number", description: "Max time to wait, in ms (default 30000)." },
            },
          },
        },
        {
          name: "peers",
          description:
            "List peers visible to Hivemind. Reports threadId, online status, and any warnings (e.g. unsupported_session_picker meaning the user must relaunch with `hm codex`).",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "get_messages",
          description:
            "Non-blocking drain of buffered Codex messages. Use after a fire-and-forget ask_codex if you don't want to block.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
          case "ask_codex": return await this.handleAskCodex(args);
          case "wait_for_codex": return await this.handleWaitForCodex(args);
          case "peers": return await this.handlePeers();
          case "get_messages": return this.handleGetMessages();
          default:
            return textResult(`Unknown tool: ${name}`, true);
        }
      } catch (e: any) {
        this.log(`Tool ${name} threw: ${e.stack ?? e.message}`);
        return textResult(`Tool error: ${e.message ?? String(e)}`, true);
      }
    });
  }

  private async handleAskCodex(args: Record<string, unknown>) {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return textResult("ask_codex requires a non-empty `text` argument.", true);
    const waitMs = typeof args.wait_ms === "number" && args.wait_ms > 0 ? args.wait_ms : 0;

    const result = await this.client.sendAsk(text, waitMs);
    if (!result.ok) {
      return textResult(formatAskError(result.error, result.errorCode), true);
    }
    if (waitMs <= 0) {
      return textResult("Sent to Codex. Use wait_for_codex or get_messages to read the reply.");
    }
    if (result.timedOut) {
      const partial = result.parts.length
        ? `\n\nPartial reply collected so far:\n${result.parts.join("\n\n")}`
        : "";
      return textResult(
        `Codex did not finish within ${waitMs}ms. The turn is still running — call wait_for_codex to collect the rest.${partial}`,
      );
    }
    if (!result.reply) {
      return textResult("Codex completed the turn without sending an agent message.");
    }
    return textResult(result.reply);
  }

  private async handleWaitForCodex(args: Record<string, unknown>) {
    const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0
      ? args.timeout_ms
      : 30000;

    if (this.buffered.length) {
      const msgs = this.drainBuffer();
      return textResult(formatMessages(msgs));
    }

    const msgs = await new Promise<HivemindMessage[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        resolve([]);
      }, timeoutMs);
      const entry: PendingWait = { resolve, timer };
      this.waiters.push(entry);
    });

    if (!msgs.length) {
      return textResult(`No new messages from Codex within ${timeoutMs}ms.`);
    }
    return textResult(formatMessages(msgs));
  }

  private async handlePeers() {
    const peers = await this.client.getPeers();
    return textResult(formatPeers(peers));
  }

  private handleGetMessages() {
    if (!this.buffered.length) return textResult("No buffered messages from Codex.");
    return textResult(formatMessages(this.drainBuffer()));
  }

  private drainBuffer(): HivemindMessage[] {
    const out = this.buffered.slice();
    this.buffered.length = 0;
    return out;
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function formatAskError(error: string, code?: string): string {
  switch (code) {
    case "PICKER_DETECTED":
      return `${error}\n\nCodex opened the session picker — Hivemind only supports fresh sessions. Relaunch with \`hm codex\` to get a new thread.`;
    case "NO_THREAD":
      return `${error}\n\nNo active Codex thread. Start one with \`hm codex\` and try again.`;
    case "TURN_BUSY":
      return `${error}\n\nCodex is mid-turn. Call wait_for_codex to collect the current reply, then retry.`;
    case "NOT_CONNECTED":
      return `${error}\n\nDaemon is not connected. Check \`hm status\` and relaunch if needed.`;
    case "TIMEOUT":
      return `${error}\n\nThe daemon never replied — it may be stuck. Try \`hm kill\` then \`hm codex\`.`;
    default:
      return error;
  }
}

function formatMessages(msgs: HivemindMessage[]): string {
  if (!msgs.length) return "No messages.";
  return msgs.map((m) => m.content).join("\n\n");
}

function formatPeers(peers: PeerInfo[]): string {
  if (!peers.length) return "No peers connected.";
  return peers.map((p) => {
    const lines = [
      `name: ${p.name}`,
      `online: ${p.online}`,
      `threadId: ${p.threadId ?? "(none)"}`,
    ];
    if (p.warnings.length) lines.push(`warnings: ${p.warnings.join(", ")}`);
    return lines.join("\n");
  }).join("\n---\n");
}
