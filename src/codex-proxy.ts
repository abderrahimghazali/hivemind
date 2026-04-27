import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import type { Logger } from "./log";
import {
  isRequest,
  isResponse,
  isNotification,
  isTrackedMethod,
  extractItemText,
  numericId,
  type CodexRequest,
  type CodexResponse,
  type CodexNotification,
  type CodexItem,
  type TurnStartParams,
} from "./codex-protocol";
import type { HivemindMessage } from "./types";
import { CLOSE_CODE_PICKER_REFUSED } from "./control-protocol";

interface TuiConnData {
  connId: number;
  isPicker: boolean;
}

interface UpstreamMapping {
  connId: number;
  clientId: number | string;
}

interface ServerRequestMapping {
  serverId: number | string;
  connId: number;
  method: string;
}

interface PendingTrackedRequest {
  method: "thread/start" | "thread/resume" | "turn/start";
  threadId?: string;
}

export interface InjectResult {
  ok: boolean;
  errorCode?: "NO_THREAD" | "NOT_CONNECTED" | "TURN_BUSY" | "PICKER_DETECTED" | "SEND_FAILED";
  message?: string;
}

interface CodexProxyEvents {
  agentMessage: [HivemindMessage];
  turnStarted: [];
  turnCompleted: [];
  ready: [string];
  tuiConnected: [number];
  tuiDisconnected: [number];
  pickerSeen: [];
  error: [Error];
  exit: [number | null];
}

const STALE_TTL_MS = 30_000;
const BRIDGE_TTL_MS = 30_000;

/**
 * Codex app-server proxy.
 *
 * Spawns `codex app-server --listen ws://...:appPort`, connects to it, and
 * runs a WebSocket proxy on `proxyPort` that the Codex TUI connects to. Along
 * the way it intercepts agentMessage notifications and exposes injection so
 * the bridge can send messages back into the active thread.
 *
 * The protocol-handling methods (`processTuiPayload`, `handleAppServerPayload`,
 * `injectMessage`) are intentionally pure with respect to I/O so they can be
 * unit-tested by driving them with raw JSON strings.
 */
export class CodexProxy extends EventEmitter<CodexProxyEvents> {
  threadId: string | null = null;
  turnInProgress = false;
  pickerSeen = false;

  private proc: ChildProcess | null = null;
  private appServerWs: WebSocket | null = null;
  private tuiWs: ServerWebSocket<TuiConnData> | null = null;
  private tuiConnId = 0;
  private proxyServer: ReturnType<typeof Bun.serve> | null = null;
  private connIdCounter = 0;
  private intentionalDisconnect = false;

  private nextProxyId = 100000;
  private nextBridgeId = -1;
  private upstreamToClient = new Map<number, UpstreamMapping>();
  private serverRequestToProxy = new Map<number, ServerRequestMapping>();
  private bridgeRequestIds = new Map<number, ReturnType<typeof setTimeout>>();
  private staleProxyIds = new Map<number, ReturnType<typeof setTimeout>>();

  private pendingTracked = new Map<string, PendingTrackedRequest>();
  private agentMessageDeltaBuffers = new Map<string, string[]>();
  private activeTurnIds = new Set<string>();

  constructor(
    private readonly appPort: number,
    private readonly proxyPort: number,
    private readonly log: Logger,
  ) {
    super();
  }

  get appServerUrl() { return `ws://127.0.0.1:${this.appPort}`; }
  get proxyUrl() { return `ws://127.0.0.1:${this.proxyPort}`; }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    await this.checkPorts();
    this.log(`Spawning codex app-server on ${this.appServerUrl}`);
    this.proc = spawn("codex", ["app-server", "--listen", this.appServerUrl], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => this.emit("exit", code));

    if (this.proc.stderr) {
      const stderrRl = createInterface({ input: this.proc.stderr });
      stderrRl.on("line", (l) => this.log(`[codex-server] ${l}`));
    }

    await this.waitForHealthy();
    await this.connectAppServer();
    this.startProxy();
    this.log(`Hivemind proxy ready on ${this.proxyUrl}`);
  }

  stop(): void {
    this.intentionalDisconnect = true;
    try { this.appServerWs?.close(); } catch {}
    this.appServerWs = null;
    try { this.proxyServer?.stop(); } catch {}
    this.proxyServer = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try { proc.kill("SIGTERM"); } catch {}
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2000);
      proc.on("exit", () => clearTimeout(killTimer));
    }
  }

  // ── Bridge-facing API ─────────────────────────────────────

  injectMessage(text: string): InjectResult {
    if (this.pickerSeen) {
      return {
        ok: false,
        errorCode: "PICKER_DETECTED",
        message: "Codex session picker is active. Hivemind v0.1 only supports a single fresh session. Run `hm kill && hm codex` to relaunch.",
      };
    }
    if (!this.threadId) {
      return {
        ok: false,
        errorCode: "NO_THREAD",
        message: "No active Codex thread. Send a message in the Codex TUI first to create a thread.",
      };
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      return {
        ok: false,
        errorCode: "NOT_CONNECTED",
        message: "Codex app-server is not connected.",
      };
    }
    if (this.turnInProgress) {
      return {
        ok: false,
        errorCode: "TURN_BUSY",
        message: "Codex is currently working on a turn. Try again after it completes.",
      };
    }
    const id = this.nextBridgeId--;
    this.trackBridgeId(id);
    const payload: CodexRequest<"turn/start", TurnStartParams> = {
      method: "turn/start",
      id,
      params: { threadId: this.threadId, input: [{ type: "text", text }] },
    };
    try {
      this.appServerWs.send(JSON.stringify(payload));
      this.log(`Bridge → Codex (id=${id}, ${text.length} chars)`);
      return { ok: true };
    } catch (err: any) {
      this.untrackBridgeId(id);
      return { ok: false, errorCode: "SEND_FAILED", message: err.message };
    }
  }

  // ── App-server connection ──────────────────────────────────

  private async waitForHealthy(maxRetries = 20, delayMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.appPort}/healthz`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Codex app-server failed to become healthy");
  }

  private connectAppServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.appServerUrl);
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.appServerWs = ws;
        this.log("Connected to Codex app-server");
        resolve();
      };
      ws.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        const forwarded = this.handleAppServerPayload(data);
        if (forwarded === null) return;
        if (this.tuiWs) {
          try { this.tuiWs.send(forwarded); }
          catch (e: any) { this.log(`Failed to forward to TUI: ${e.message}`); }
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Failed to connect to Codex app-server"));
        }
      };
      ws.onclose = () => {
        this.log("App-server connection closed");
        this.appServerWs = null;
        if (!this.intentionalDisconnect) this.emit("error", new Error("Codex app-server connection lost"));
      };
    });
  }

  // ── TUI proxy server ──────────────────────────────────────

  private startProxy() {
    const self = this;
    this.proxyServer = Bun.serve({
      port: this.proxyPort,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return fetch(`http://127.0.0.1:${self.appPort}/healthz`);
        }
        if (server.upgrade(req, { data: { connId: 0, isPicker: false } })) return undefined;
        return new Response("Hivemind Codex Proxy");
      },
      websocket: {
        open: (ws: ServerWebSocket<TuiConnData>) => self.onTuiConnect(ws),
        close: (ws: ServerWebSocket<TuiConnData>) => self.onTuiDisconnect(ws),
        message: (ws: ServerWebSocket<TuiConnData>, msg) => {
          const data = typeof msg === "string" ? msg : msg.toString();
          self.onTuiMessage(ws, data);
        },
      },
    });
  }

  private onTuiConnect(ws: ServerWebSocket<TuiConnData>) {
    const connId = ++this.connIdCounter;
    ws.data.connId = connId;
    ws.data.isPicker = false;

    if (this.tuiWs) {
      ws.data.isPicker = true;
      this.pickerSeen = true;
      this.log(`PICKER detected: refusing secondary TUI connection (conn #${connId}, primary #${this.tuiConnId})`);
      this.emit("pickerSeen");
      try {
        ws.close(
          CLOSE_CODE_PICKER_REFUSED,
          "Hivemind v0.1 does not support the Codex session picker. Run `hm kill && hm codex` to relaunch.",
        );
      } catch {}
      return;
    }

    this.tuiWs = ws;
    this.tuiConnId = connId;
    this.threadId = null;
    this.turnInProgress = false;
    this.activeTurnIds.clear();
    this.log(`TUI connected (conn #${connId})`);
    this.emit("tuiConnected", connId);
  }

  private onTuiDisconnect(ws: ServerWebSocket<TuiConnData>) {
    const { connId, isPicker } = ws.data;
    if (isPicker) {
      this.log(`Picker connection closed (conn #${connId})`);
      return;
    }
    if (this.tuiWs === ws) {
      this.tuiWs = null;
      this.log(`TUI disconnected (conn #${connId})`);
      this.emit("tuiDisconnected", connId);
      this.retireConnection(connId);
    }
  }

  private onTuiMessage(ws: ServerWebSocket<TuiConnData>, raw: string): void {
    const { connId, isPicker } = ws.data;
    if (isPicker) return;
    if (connId !== this.tuiConnId) {
      this.log(`Dropping stale TUI message from conn #${connId} (current #${this.tuiConnId})`);
      return;
    }
    const forwarded = this.processTuiPayload(raw, connId);
    if (forwarded === null) return;
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("App-server not connected, dropping TUI message");
      return;
    }
    try { this.appServerWs.send(forwarded); }
    catch (e: any) { this.log(`Failed to send to app-server: ${e.message}`); }
  }

  // ── Pure protocol logic (testable) ─────────────────────────

  /**
   * Process a payload from the TUI. Returns the (possibly id-rewritten)
   * payload to forward to the app-server, or null to drop. Pure with respect
   * to I/O — safe to call directly in tests.
   */
  processTuiPayload(raw: string, connId: number): string | null {
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { this.log("TUI sent unparseable payload — passing through"); return raw; }

    // Response from TUI to a server-initiated request (id present, no method).
    if (parsed.id !== undefined && !parsed.method) {
      const proxyId = numericId(parsed.id);
      if (isNaN(proxyId)) return raw;
      const mapping = this.serverRequestToProxy.get(proxyId);
      if (!mapping) {
        this.log(`Unmatched TUI response: proxy id=${proxyId}`);
        return null;
      }
      if (mapping.connId !== connId) {
        this.log(`Stale TUI response (proxy id=${proxyId}, expected conn #${mapping.connId}, got #${connId})`);
        return null;
      }
      this.serverRequestToProxy.delete(proxyId);
      parsed.id = mapping.serverId;
      this.log(`TUI → app-server: ${mapping.method} response (proxy id=${proxyId} → server id=${String(parsed.id)})`);
      return JSON.stringify(parsed);
    }

    // Request from TUI to app-server.
    if (parsed.id !== undefined && typeof parsed.method === "string") {
      const clientId = parsed.id;
      const proxyId = this.nextProxyId++;
      this.upstreamToClient.set(proxyId, { connId, clientId });
      this.trackPendingTracked(proxyId, parsed);
      parsed.id = proxyId;
      this.log(`TUI → app-server: ${parsed.method} (client id=${String(clientId)} → proxy id=${proxyId})`);
      return JSON.stringify(parsed);
    }

    // Notification (no id) — pass through unchanged.
    return raw;
  }

  /**
   * Process a payload from the app-server. Returns the (possibly id-rewritten)
   * payload to forward to the TUI, or null to drop. Pure with respect to I/O.
   */
  handleAppServerPayload(raw: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { return raw; }

    if (isNotification(parsed)) {
      this.handleNotification(parsed);
      return raw;
    }
    if (isRequest(parsed)) {
      return this.handleServerRequest(parsed);
    }
    if (isResponse(parsed)) {
      return this.handleAppServerResponse(parsed);
    }
    this.log(`Dropping unclassifiable app-server payload: ${raw.slice(0, 100)}`);
    return null;
  }

  private handleServerRequest(parsed: CodexRequest): string | null {
    const serverId = parsed.id;
    const method = parsed.method;
    if (!this.tuiWs) {
      this.log(`Dropping server request (no TUI): ${method} (server id=${String(serverId)})`);
      return null;
    }
    const proxyId = this.nextProxyId++;
    this.serverRequestToProxy.set(proxyId, { serverId, connId: this.tuiConnId, method });
    parsed.id = proxyId;
    this.log(`Server request: ${method} (server id=${String(serverId)} → proxy id=${proxyId})`);
    return JSON.stringify(parsed);
  }

  private handleAppServerResponse(parsed: CodexResponse): string | null {
    const id = numericId(parsed.id);
    if (isNaN(id)) {
      this.log(`Dropping app-server response with non-numeric id: ${String(parsed.id)}`);
      return null;
    }

    if (this.consumeBridgeId(id)) {
      if (parsed.error) {
        this.log(`Bridge request failed (id=${id}): ${parsed.error.message ?? "unknown"}`);
      } else {
        this.log(`Bridge request completed (id=${id})`);
      }
      this.handleTrackedResponse(parsed, id);
      return null;
    }

    const mapping = this.upstreamToClient.get(id);
    if (mapping) {
      this.upstreamToClient.delete(id);
      if (mapping.connId !== this.tuiConnId) {
        this.log(`Dropping stale response (proxy id=${id}, conn #${mapping.connId}, current #${this.tuiConnId})`);
        return null;
      }
      parsed.id = mapping.clientId;
      this.handleTrackedResponse(parsed, id);
      this.log(`app-server → TUI: response (proxy id=${id} → client id=${String(parsed.id)})`);
      return JSON.stringify(parsed);
    }

    if (this.consumeStaleId(id)) {
      this.log(`Dropping retired response (proxy id=${id})`);
      return null;
    }

    this.log(`Dropping unmatched app-server response (proxy id=${id})`);
    return null;
  }

  private handleNotification(msg: CodexNotification) {
    const params = (msg as any).params;
    switch (msg.method) {
      case "turn/started":
        this.markTurnStarted(params?.turn?.id);
        break;
      case "item/started": {
        const item = params?.item as CodexItem | undefined;
        if (item?.type === "agentMessage") this.agentMessageDeltaBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = params?.itemId;
        if (typeof itemId !== "string") break;
        const buf = this.agentMessageDeltaBuffers.get(itemId);
        if (buf && typeof params?.delta === "string") buf.push(params.delta);
        break;
      }
      case "item/completed": {
        const item = params?.item as CodexItem | undefined;
        if (item?.type === "agentMessage") {
          const content = this.extractAgentMessage(item);
          this.agentMessageDeltaBuffers.delete(item.id);
          if (content) {
            this.log(`Codex agentMessage completed (${content.length} chars)`);
            this.emit("agentMessage", { id: item.id, source: "codex", content, ts: Date.now() });
          }
        }
        break;
      }
      case "turn/completed": {
        const wasInProgress = this.turnInProgress;
        this.markTurnCompleted(params?.turn?.id);
        if (wasInProgress && !this.turnInProgress) this.emit("turnCompleted");
        break;
      }
    }
  }

  private extractAgentMessage(item: CodexItem): string {
    const direct = extractItemText(item);
    if (direct) return direct;
    return this.agentMessageDeltaBuffers.get(item.id)?.join("") ?? "";
  }

  // ── Tracked request bookkeeping ────────────────────────────

  private trackPendingTracked(proxyId: number, message: any) {
    if (!isTrackedMethod(message?.method)) return;
    const pending: PendingTrackedRequest = { method: message.method };
    if (message.method === "turn/start") {
      const tid = message?.params?.threadId;
      if (typeof tid === "string" && tid.length) pending.threadId = tid;
    }
    this.pendingTracked.set(String(proxyId), pending);
  }

  private handleTrackedResponse(message: CodexResponse, id: number) {
    const key = String(id);
    const pending = this.pendingTracked.get(key);
    if (!pending) return;
    this.pendingTracked.delete(key);
    if (message.error) return;

    const result = message.result as Record<string, any> | undefined;
    switch (pending.method) {
      case "thread/start":
      case "thread/resume": {
        const tid = result?.thread?.id;
        if (typeof tid === "string" && tid.length) this.setActiveThread(tid, pending.method);
        break;
      }
      case "turn/start":
        if (pending.threadId) this.setActiveThread(pending.threadId, "turn/start");
        break;
    }
  }

  private setActiveThread(threadId: string, reason: string) {
    if (this.threadId === threadId) return;
    const previous = this.threadId;
    this.threadId = threadId;
    if (previous) {
      this.log(`Active thread changed: ${previous} → ${threadId} (${reason})`);
    } else {
      this.log(`Thread detected: ${threadId} (${reason})`);
      this.emit("ready", threadId);
    }
  }

  private markTurnStarted(turnId?: string) {
    const wasInProgress = this.turnInProgress;
    const id = typeof turnId === "string" && turnId ? turnId : `unknown:${Date.now()}`;
    this.activeTurnIds.add(id);
    this.turnInProgress = this.activeTurnIds.size > 0;
    if (!wasInProgress && this.turnInProgress) this.emit("turnStarted");
  }

  private markTurnCompleted(turnId?: string) {
    if (typeof turnId === "string" && turnId) {
      this.activeTurnIds.delete(turnId);
    } else {
      this.activeTurnIds.clear();
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
  }

  // ── ID lifecycle helpers ──────────────────────────────────

  private trackBridgeId(id: number): void {
    this.clearTracked(this.bridgeRequestIds, id);
    const t = setTimeout(() => this.bridgeRequestIds.delete(id), BRIDGE_TTL_MS);
    t.unref?.();
    this.bridgeRequestIds.set(id, t);
  }

  private consumeBridgeId(id: number): boolean {
    return this.clearTracked(this.bridgeRequestIds, id);
  }

  private untrackBridgeId(id: number): void {
    this.clearTracked(this.bridgeRequestIds, id);
  }

  private trackStaleId(id: number): void {
    this.clearTracked(this.staleProxyIds, id);
    const t = setTimeout(() => this.staleProxyIds.delete(id), STALE_TTL_MS);
    t.unref?.();
    this.staleProxyIds.set(id, t);
  }

  private consumeStaleId(id: number): boolean {
    return this.clearTracked(this.staleProxyIds, id);
  }

  private clearTracked(map: Map<number, ReturnType<typeof setTimeout>>, id: number): boolean {
    const t = map.get(id);
    if (!t) return false;
    clearTimeout(t);
    map.delete(id);
    return true;
  }

  private retireConnection(connId: number): void {
    for (const [pid, m] of this.upstreamToClient.entries()) {
      if (m.connId === connId) {
        this.upstreamToClient.delete(pid);
        this.trackStaleId(pid);
      }
    }
    for (const [pid, m] of this.serverRequestToProxy.entries()) {
      if (m.connId === connId) this.serverRequestToProxy.delete(pid);
    }
  }

  // ── Port hygiene ──────────────────────────────────────────

  private async checkPorts() {
    for (const port of [this.appPort, this.proxyPort]) {
      try {
        const pids = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
        if (!pids) continue;
        const list = pids.split("\n").map((p) => p.trim()).filter(Boolean);
        const stale: string[] = [];
        const foreign: string[] = [];
        for (const pid of list) {
          try {
            const cmd = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8" }).trim();
            if (cmd.includes("codex") && cmd.includes("app-server")) stale.push(pid);
            else foreign.push(pid);
          } catch {}
        }
        if (stale.length) {
          this.log(`Cleaning stale codex app-server on :${port}: ${stale.join(", ")}`);
          for (const pid of stale) {
            try { execSync(`kill ${pid}`); } catch {}
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (foreign.length) {
          throw new Error(
            `Port ${port} is in use by non-Codex process(es): ${foreign.join(", ")}. ` +
            `Set ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} to a different port.`,
          );
        }
      } catch (err: any) {
        if (err.message?.includes("Port ")) throw err;
      }
    }
  }
}
