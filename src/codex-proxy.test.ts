import { test, expect, describe } from "bun:test";
import { CodexProxy } from "./codex-proxy";
import type { HivemindMessage } from "./types";

const noop = () => {};

function makeProxy() {
  return new CodexProxy(0, 0, noop);
}

/** Stub the app-server socket so injectMessage can run without real I/O. */
function attachFakeAppServer(proxy: CodexProxy): { sent: string[] } {
  const sent: string[] = [];
  (proxy as any).appServerWs = {
    readyState: 1, // WebSocket.OPEN
    send: (s: string) => { sent.push(s); },
  };
  return { sent };
}

// ── 1. TUI request id rewrite + response restore ──────────

describe("TUI ↔ app-server id rewriting", () => {
  test("rewrites TUI request id outbound and restores it on the response", () => {
    const proxy = makeProxy();
    (proxy as any).tuiConnId = 1;

    const outbound = proxy.processTuiPayload(
      JSON.stringify({ id: 7, method: "thread/start", params: {} }),
      1,
    );
    const parsedOut = JSON.parse(outbound!);
    expect(parsedOut.id).toBe(100000);
    expect(parsedOut.method).toBe("thread/start");

    const restored = proxy.handleAppServerPayload(
      JSON.stringify({ id: 100000, result: { thread: { id: "thread_abc" } } }),
    );
    const parsedRestored = JSON.parse(restored!);
    expect(parsedRestored.id).toBe(7);
    // thread/start completion sets the active thread.
    expect(proxy.threadId).toBe("thread_abc");
  });

  test("preserves string client ids across the rewrite", () => {
    const proxy = makeProxy();
    (proxy as any).tuiConnId = 1;

    const outbound = proxy.processTuiPayload(
      JSON.stringify({ id: "abc-1", method: "turn/start", params: { threadId: "t1" } }),
      1,
    );
    expect(JSON.parse(outbound!).id).toBe(100000);

    const restored = proxy.handleAppServerPayload(
      JSON.stringify({ id: 100000, result: {} }),
    );
    expect(JSON.parse(restored!).id).toBe("abc-1");
  });
});

// ── 2. Stale-conn responses dropped ──────────────────────

describe("retired connection cleanup", () => {
  test("drops responses for requests whose connection was retired", () => {
    const proxy = makeProxy();
    (proxy as any).tuiConnId = 1;

    proxy.processTuiPayload(
      JSON.stringify({ id: 5, method: "thread/start" }),
      1,
    );

    // Conn 1 disappears, conn 2 takes over.
    (proxy as any).retireConnection(1);
    (proxy as any).tuiConnId = 2;

    const out = proxy.handleAppServerPayload(
      JSON.stringify({ id: 100000, result: {} }),
    );
    expect(out).toBeNull();
  });

  test("drops cross-conn TUI responses to server requests", () => {
    const proxy = makeProxy();
    (proxy as any).tuiConnId = 1;
    (proxy as any).tuiWs = {} as any; // server-request handler requires a TUI

    // Server-initiated request → proxy id 100000, bound to conn 1.
    const fwd = proxy.handleAppServerPayload(
      JSON.stringify({ id: "srv-1", method: "execApprovalRequest", params: {} }),
    );
    expect(JSON.parse(fwd!).id).toBe(100000);

    // A different conn tries to answer — must be dropped (mapping.connId mismatch).
    const out = proxy.processTuiPayload(JSON.stringify({ id: 100000, result: "ok" }), 2);
    expect(out).toBeNull();
  });
});

// ── 3. Bridge-originated negative ids consumed, not forwarded ──

describe("bridge id lifecycle", () => {
  test("injectMessage uses negative ids and consumes the response without forwarding", () => {
    const proxy = makeProxy();
    proxy.threadId = "thread_abc";
    const fake = attachFakeAppServer(proxy);

    const result = proxy.injectMessage("hello codex");
    expect(result.ok).toBe(true);
    expect(fake.sent.length).toBe(1);

    const sent = JSON.parse(fake.sent[0]!);
    expect(sent.id).toBe(-1);
    expect(sent.method).toBe("turn/start");
    expect(sent.params.threadId).toBe("thread_abc");
    expect(sent.params.input[0]).toEqual({ type: "text", text: "hello codex" });

    // Response with id=-1 must be consumed silently (no TUI forward).
    const out = proxy.handleAppServerPayload(
      JSON.stringify({ id: -1, result: {} }),
    );
    expect(out).toBeNull();
  });
});

// ── 4. Inject gates ──────────────────────────────────────

describe("injectMessage gates", () => {
  test("refuses when no thread is active", () => {
    const proxy = makeProxy();
    attachFakeAppServer(proxy);
    const result = proxy.injectMessage("hi");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NO_THREAD");
  });

  test("refuses when a turn is already in progress", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);
    proxy.turnInProgress = true;
    const result = proxy.injectMessage("hi");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TURN_BUSY");
  });

  test("refuses with PICKER_DETECTED once the picker has been seen", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);
    proxy.pickerSeen = true;
    const result = proxy.injectMessage("hi");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PICKER_DETECTED");
    expect(result.message ?? "").toContain("hm kill");
  });

  test("refuses when the app-server socket is not open", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    (proxy as any).appServerWs = { readyState: 3, send: () => {} }; // CLOSED
    const result = proxy.injectMessage("hi");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_CONNECTED");
  });
});

// ── 5. agentMessage extraction (content + delta fallback) ──

describe("agentMessage extraction", () => {
  test("emits agentMessage from item.content when present", () => {
    const proxy = makeProxy();
    const captured: { msg: HivemindMessage; fromBridge: boolean }[] = [];
    proxy.on("agentMessage", (m, meta) => captured.push({ msg: m, fromBridge: meta.fromBridge }));

    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          id: "i1",
          type: "agentMessage",
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    }));

    expect(captured.length).toBe(1);
    expect(captured[0]!.msg.content).toBe("Hello world");
    expect(captured[0]!.msg.source).toBe("codex");
    expect(captured[0]!.msg.id).toBe("i1");
    // No bridge inject happened, so this is a non-bridge (TUI) message.
    expect(captured[0]!.fromBridge).toBe(false);
  });

  test("falls back to the delta buffer when item.content is empty", () => {
    const proxy = makeProxy();
    const captured: HivemindMessage[] = [];
    proxy.on("agentMessage", (m) => captured.push(m));

    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/started",
      params: { item: { id: "i2", type: "agentMessage" } },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { itemId: "i2", delta: "First " },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { itemId: "i2", delta: "second." },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/completed",
      params: { item: { id: "i2", type: "agentMessage" } },
    }));

    expect(captured.length).toBe(1);
    expect(captured[0]!.content).toBe("First second.");
  });

  test("does not emit agentMessage for non-agentMessage item types", () => {
    const proxy = makeProxy();
    const captured: HivemindMessage[] = [];
    proxy.on("agentMessage", (m) => captured.push(m));

    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/completed",
      params: { item: { id: "i3", type: "reasoning", content: [{ type: "text", text: "thinking" }] } },
    }));

    expect(captured.length).toBe(0);
  });
});

// ── 6. Turn lifecycle ────────────────────────────────────

describe("turn lifecycle", () => {
  test("turn/started and turn/completed toggle turnInProgress", () => {
    const proxy = makeProxy();
    let started = 0;
    const completedEvents: { fromBridge: boolean; turnId: string | null }[] = [];
    proxy.on("turnStarted", () => started++);
    proxy.on("turnCompleted", (meta) => completedEvents.push(meta));

    expect(proxy.turnInProgress).toBe(false);

    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/started",
      params: { turn: { id: "tn1" } },
    }));
    expect(proxy.turnInProgress).toBe(true);
    expect(started).toBe(1);

    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "tn1" } },
    }));
    expect(proxy.turnInProgress).toBe(false);
    expect(completedEvents).toEqual([{ fromBridge: false, turnId: "tn1" }]);
  });
});

// ── 7. Bridge turn correlation ───────────────────────────

describe("bridge turn correlation", () => {
  test("agentMessage during a bridge-originated turn is fromBridge=true", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);

    const captured: { fromBridge: boolean; content: string }[] = [];
    proxy.on("agentMessage", (m, meta) =>
      captured.push({ fromBridge: meta.fromBridge, content: m.content }),
    );

    expect(proxy.injectMessage("hi").ok).toBe(true);
    proxy.handleAppServerPayload(JSON.stringify({ id: -1, result: {} }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/started",
      params: { turn: { id: "tn-bridge" } },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          id: "i1",
          type: "agentMessage",
          content: [{ type: "text", text: "hi back" }],
        },
      },
    }));

    expect(captured).toEqual([{ fromBridge: true, content: "hi back" }]);
  });

  test("agentMessage during a TUI-originated turn is fromBridge=false", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);

    const captured: { fromBridge: boolean }[] = [];
    proxy.on("agentMessage", (_m, meta) => captured.push({ fromBridge: meta.fromBridge }));

    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/started",
      params: { turn: { id: "tn-tui" } },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          id: "i2",
          type: "agentMessage",
          content: [{ type: "text", text: "from tui" }],
        },
      },
    }));

    expect(captured).toEqual([{ fromBridge: false }]);
  });

  test("turnCompleted reports fromBridge correctly for both turn origins", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);

    const events: { fromBridge: boolean; turnId: string | null }[] = [];
    proxy.on("turnCompleted", (meta) => events.push(meta));

    // TUI turn first.
    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/started",
      params: { turn: { id: "tn-tui" } },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "tn-tui" } },
    }));

    // Then a bridge inject.
    proxy.injectMessage("hi");
    proxy.handleAppServerPayload(JSON.stringify({ id: -1, result: {} }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/started",
      params: { turn: { id: "tn-bridge" } },
    }));
    proxy.handleAppServerPayload(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "tn-bridge" } },
    }));

    expect(events).toEqual([
      { fromBridge: false, turnId: "tn-tui" },
      { fromBridge: true, turnId: "tn-bridge" },
    ]);
  });
});

// ── 8. Fire-and-forget reservation ───────────────────────

describe("fire-and-forget reservation", () => {
  test("second injectMessage is blocked while a bridge request is in flight", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    attachFakeAppServer(proxy);

    const first = proxy.injectMessage("first");
    expect(first.ok).toBe(true);

    // bridgeRequestIds still contains -1, so the gate must reject.
    const second = proxy.injectMessage("second");
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe("TURN_BUSY");
  });

  test("a fresh inject succeeds once the bridge response has been consumed", () => {
    const proxy = makeProxy();
    proxy.threadId = "t1";
    const fake = attachFakeAppServer(proxy);

    proxy.injectMessage("first");
    proxy.handleAppServerPayload(JSON.stringify({ id: -1, result: {} }));

    // Bridge id consumed and turn/started not yet fired — gate is open again.
    const second = proxy.injectMessage("second");
    expect(second.ok).toBe(true);
    expect(fake.sent).toHaveLength(2);
  });
});
