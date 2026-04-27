import { EventEmitter } from "node:events";
import type {
  ControlClientMessage,
  ControlServerMessage,
  DaemonStatus,
  AskResult,
} from "./control-protocol";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { HivemindMessage, PeerInfo } from "./types";
import type { Logger } from "./log";

export interface DaemonClientOptions {
  url: string;
  log: Logger;
}

interface PendingAsk {
  resolve: (r: AskResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPeers {
  resolve: (peers: PeerInfo[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * WebSocket client to the Hivemind daemon control endpoint.
 *
 * Events:
 *   "connected"         — socket open + claude_connect sent
 *   "disconnected"      — socket closed (any reason)
 *   "replaced"          — daemon kicked us off (CLOSE_CODE_REPLACED)
 *   "codexMessage" (m)  — agent message from Codex
 *   "status" (s)        — daemon status update
 */
export class DaemonClient extends EventEmitter {
  private readonly url: string;
  private readonly log: Logger;
  private ws: WebSocket | null = null;
  private nextRequestId = 0;
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private readonly pendingPeers = new Map<string, PendingPeers>();
  private latestStatus: DaemonStatus | null = null;

  constructor(opts: DaemonClientOptions) {
    super();
    this.url = opts.url;
    this.log = opts.log;
  }

  get status(): DaemonStatus | null { return this.latestStatus; }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (e: Event) => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`Failed to connect to daemon at ${this.url}: ${(e as any)?.message ?? "unknown"}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

    ws.addEventListener("message", (ev) => {
      this.handleMessage(typeof ev.data === "string" ? ev.data : ev.data.toString());
    });
    ws.addEventListener("close", (ev) => {
      this.log(`Daemon socket closed (code=${ev.code}, reason=${ev.reason || "n/a"})`);
      this.ws = null;
      this.failAllPending(`Daemon disconnected (code=${ev.code})`);
      if (ev.code === CLOSE_CODE_REPLACED) {
        this.emit("replaced");
      }
      this.emit("disconnected", ev.code);
    });
    ws.addEventListener("error", (ev) => {
      this.log(`Daemon socket error: ${(ev as any)?.message ?? "unknown"}`);
    });

    this.send({ type: "claude_connect" });
    this.send({ type: "status_request" });
    this.emit("connected");
  }

  disconnect(): void {
    if (!this.ws) return;
    try { this.send({ type: "claude_disconnect" }); } catch {}
    try { this.ws.close(); } catch {}
    this.ws = null;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send an ask_codex request and wait for the daemon's ask_result.
   *
   * Client timeout is set to waitMs + 5s (min 30s) to give the daemon room to
   * resolve its own waiter (which is the source of truth for the turn outcome).
   */
  async sendAsk(text: string, waitMs?: number): Promise<AskResult> {
    if (!this.isOpen()) {
      return { ok: false, error: "Not connected to daemon", errorCode: "NOT_CONNECTED" };
    }
    const requestId = `ask_${++this.nextRequestId}`;
    const clientTimeoutMs = Math.max((waitMs ?? 0) + 5000, 30000);

    return new Promise<AskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(requestId);
        resolve({ ok: false, error: `Daemon did not respond within ${clientTimeoutMs}ms`, errorCode: "TIMEOUT" });
      }, clientTimeoutMs);
      this.pendingAsks.set(requestId, { resolve, timer });
      this.send({ type: "ask_codex", requestId, text, waitMs });
    });
  }

  async getPeers(timeoutMs = 5000): Promise<PeerInfo[]> {
    if (!this.isOpen()) return [];
    const requestId = `peers_${++this.nextRequestId}`;
    return new Promise<PeerInfo[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPeers.delete(requestId);
        resolve([]);
      }, timeoutMs);
      this.pendingPeers.set(requestId, { resolve, timer });
      this.send({ type: "peers_request", requestId });
    });
  }

  private send(msg: ControlClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Daemon socket not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string): void {
    let msg: ControlServerMessage;
    try { msg = JSON.parse(raw); }
    catch (e: any) { this.log(`Bad daemon payload: ${e.message}`); return; }

    switch (msg.type) {
      case "codex_message":
        this.emit("codexMessage", msg.message as HivemindMessage);
        return;
      case "ask_result": {
        const pending = this.pendingAsks.get(msg.requestId);
        if (!pending) return;
        this.pendingAsks.delete(msg.requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg.result);
        return;
      }
      case "peers_result": {
        const pending = this.pendingPeers.get(msg.requestId);
        if (!pending) return;
        this.pendingPeers.delete(msg.requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg.peers);
        return;
      }
      case "status":
        this.latestStatus = msg.status;
        this.emit("status", msg.status);
        return;
    }
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pendingAsks) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: reason, errorCode: "NOT_CONNECTED" });
    }
    this.pendingAsks.clear();
    for (const [, pending] of this.pendingPeers) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    this.pendingPeers.clear();
  }
}
