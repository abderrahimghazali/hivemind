#!/usr/bin/env bun

import type { ServerWebSocket } from "bun";
import { CodexProxy } from "./codex-proxy";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDir } from "./state-dir";
import { makeLogger } from "./log";
import { withContract } from "./bridge-contract";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type {
  ControlClientMessage,
  ControlServerMessage,
  DaemonStatus,
  AskResult,
} from "./control-protocol";
import type { HivemindMessage, PeerInfo } from "./types";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
}

const stateDir = new StateDir();
stateDir.ensure();
const log = makeLogger("HivemindDaemon", stateDir.logFile);

const APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? "4600", 10);
const PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? "4601", 10);
const CONTROL_PORT = parseInt(process.env.HIVEMIND_CONTROL_PORT ?? "4602", 10);
const IDLE_SHUTDOWN_MS = parseInt(process.env.HIVEMIND_IDLE_SHUTDOWN_MS ?? "60000", 10);

const lifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

if (lifecycle.wasKilled()) {
  log("Killed sentinel found — refusing to start. Run `hm codex` to clear and relaunch.");
  process.exit(0);
}

const proxy = new CodexProxy(APP_PORT, PROXY_PORT, makeLogger("CodexProxy", stateDir.logFile));

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let attachedBridge: ServerWebSocket<ControlSocketData> | null = null;
let nextClientId = 0;
let nextMessageId = 0;
let shuttingDown = false;
let proxyReady = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const queuedMessages: HivemindMessage[] = [];
const MAX_QUEUE = 100;

interface ActiveWaiter {
  requestId: string;
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
  ws: ServerWebSocket<ControlSocketData>;
}
let activeWaiter: ActiveWaiter | null = null;

// ── Proxy event wiring ────────────────────────────────────

proxy.on("agentMessage", (msg) => {
  if (activeWaiter) {
    activeWaiter.parts.push(msg.content);
    return;
  }
  enqueueAndPush(msg);
});

proxy.on("turnCompleted", () => {
  if (!activeWaiter) return;
  const w = activeWaiter;
  activeWaiter = null;
  clearTimeout(w.timer);
  resolveAsk(w.ws, w.requestId, {
    ok: true,
    reply: w.parts.join("\n\n"),
    parts: w.parts,
    timedOut: false,
  });
});

proxy.on("ready", (threadId) => {
  log(`Codex thread ready: ${threadId}`);
  broadcastStatus();
});

proxy.on("tuiConnected", (connId) => {
  log(`Codex TUI connected (#${connId})`);
  cancelIdleShutdown();
  broadcastStatus();
});

proxy.on("tuiDisconnected", (connId) => {
  log(`Codex TUI disconnected (#${connId})`);
  scheduleIdleShutdown();
  broadcastStatus();
});

proxy.on("pickerSeen", () => {
  log("Picker connection refused — peers will report unsupported_session_picker");
  broadcastStatus();
});

proxy.on("error", (err) => {
  log(`Proxy error: ${err.message}`);
});

proxy.on("exit", (code) => {
  log(`Codex app-server exited (${code})`);
});

// ── Control WS server ─────────────────────────────────────

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify(currentStatus()), {
          status: proxyReady ? 200 : 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false } })) {
        return undefined;
      }
      return new Response("Hivemind daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextClientId;
        log(`Control socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>) => {
        log(`Control socket closed (#${ws.data.clientId})`);
        if (attachedBridge === ws) detachBridge(ws);
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, typeof raw === "string" ? raw : raw.toString());
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string) {
  let msg: ControlClientMessage;
  try { msg = JSON.parse(raw); }
  catch (e: any) { log(`Bad control payload: ${e.message}`); return; }

  switch (msg.type) {
    case "claude_connect":
      attachBridge(ws);
      return;
    case "claude_disconnect":
      detachBridge(ws);
      return;
    case "status_request":
      sendControl(ws, { type: "status", status: currentStatus() });
      return;
    case "peers_request":
      sendControl(ws, { type: "peers_result", requestId: msg.requestId, peers: currentPeers() });
      return;
    case "ask_codex":
      handleAskCodex(ws, msg);
      return;
  }
}

function handleAskCodex(
  ws: ServerWebSocket<ControlSocketData>,
  msg: Extract<ControlClientMessage, { type: "ask_codex" }>,
) {
  const result = proxy.injectMessage(withContract(msg.text));
  if (!result.ok) {
    resolveAsk(ws, msg.requestId, {
      ok: false,
      error: result.message ?? "Failed to inject message",
      errorCode: result.errorCode,
    });
    return;
  }
  log(`ask_codex sent (requestId=${msg.requestId}, waitMs=${msg.waitMs ?? 0})`);

  const waitMs = msg.waitMs ?? 0;
  if (waitMs <= 0) {
    resolveAsk(ws, msg.requestId, { ok: true, reply: "", parts: [], timedOut: false });
    return;
  }

  if (activeWaiter) {
    // Defensive — proxy.turnInProgress should have rejected the second injection.
    resolveAsk(ws, msg.requestId, {
      ok: false,
      error: "Another wait is currently active",
      errorCode: "TURN_BUSY",
    });
    return;
  }

  const waiter: ActiveWaiter = {
    requestId: msg.requestId,
    parts: [],
    ws,
    timer: setTimeout(() => {
      if (activeWaiter !== waiter) return;
      activeWaiter = null;
      resolveAsk(waiter.ws, waiter.requestId, {
        ok: true,
        reply: waiter.parts.join("\n\n"),
        parts: waiter.parts,
        timedOut: true,
      });
    }, waitMs),
  };
  activeWaiter = waiter;
}

function resolveAsk(
  ws: ServerWebSocket<ControlSocketData>,
  requestId: string,
  result: AskResult,
) {
  sendControl(ws, { type: "ask_result", requestId, result });
}

function attachBridge(ws: ServerWebSocket<ControlSocketData>) {
  if (attachedBridge && attachedBridge !== ws && attachedBridge.readyState !== WebSocket.CLOSED) {
    log(`Replacing previous bridge (#${attachedBridge.data.clientId}) with #${ws.data.clientId}`);
    try { attachedBridge.close(CLOSE_CODE_REPLACED, "replaced by newer bridge"); } catch {}
  }
  attachedBridge = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`Bridge attached (#${ws.data.clientId})`);

  // Flush any queued messages.
  while (queuedMessages.length) {
    const msg = queuedMessages.shift()!;
    sendControl(ws, { type: "codex_message", message: msg });
  }
  sendControl(ws, { type: "status", status: currentStatus() });
}

function detachBridge(ws: ServerWebSocket<ControlSocketData>) {
  if (attachedBridge !== ws) return;
  attachedBridge = null;
  ws.data.attached = false;
  log(`Bridge detached (#${ws.data.clientId})`);
  scheduleIdleShutdown();
}

// ── Message queue + push ─────────────────────────────────

function enqueueAndPush(msg: HivemindMessage) {
  msg.id = msg.id || `codex_${++nextMessageId}`;
  if (attachedBridge && attachedBridge.readyState === WebSocket.OPEN) {
    sendControl(attachedBridge, { type: "codex_message", message: msg });
    return;
  }
  queuedMessages.push(msg);
  if (queuedMessages.length > MAX_QUEUE) {
    const dropped = queuedMessages.length - MAX_QUEUE;
    queuedMessages.splice(0, dropped);
    log(`Queue overflow: dropped ${dropped} oldest message(s)`);
  }
}

function sendControl(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try { ws.send(JSON.stringify(message)); }
  catch (e: any) { log(`Send failed: ${e.message}`); }
}

function broadcastStatus() {
  if (!attachedBridge) return;
  sendControl(attachedBridge, { type: "status", status: currentStatus() });
}

function currentStatus(): DaemonStatus {
  return {
    codexConnected: proxy.threadId !== null && !proxy.pickerSeen,
    threadId: proxy.threadId,
    pickerActive: proxy.pickerSeen,
    queuedMessages: queuedMessages.length,
    pid: process.pid,
  };
}

function currentPeers(): PeerInfo[] {
  const warnings: string[] = [];
  if (proxy.pickerSeen) warnings.push("unsupported_session_picker");
  return [{
    name: "codex",
    online: proxy.threadId !== null && !proxy.pickerSeen,
    threadId: proxy.threadId,
    warnings,
  }];
}

// ── Idle shutdown ────────────────────────────────────────

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (attachedBridge) return;
  log(`No bridge attached — daemon will exit in ${IDLE_SHUTDOWN_MS}ms if no one reconnects`);
  idleTimer = setTimeout(() => {
    if (attachedBridge) return;
    shutdown("idle");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ── Boot + shutdown ──────────────────────────────────────

async function boot() {
  log("Starting Hivemind daemon");
  log(`Codex app-server: ws://127.0.0.1:${APP_PORT}`);
  log(`Codex proxy:      ws://127.0.0.1:${PROXY_PORT}`);
  log(`Control:          ws://127.0.0.1:${CONTROL_PORT}/ws`);

  lifecycle.writePid();
  lifecycle.writeStatus({
    appServerUrl: proxy.appServerUrl,
    proxyUrl: proxy.proxyUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });

  startControlServer();

  try {
    await proxy.start();
    proxyReady = true;
    log("Daemon healthy: control + proxy listening");
  } catch (err: any) {
    log(`Failed to start Codex proxy: ${err.message}`);
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${reason})`);
  cancelIdleShutdown();
  try { controlServer?.stop(); } catch {}
  proxy.stop();
  lifecycle.removePidFile();
  lifecycle.removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => log(`UNCAUGHT: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (reason: any) => log(`UNHANDLED: ${reason?.stack ?? reason}`));

void boot();
