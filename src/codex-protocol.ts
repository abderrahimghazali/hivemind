/**
 * Codex app-server JSON-RPC protocol.
 *
 * Codex runs as `codex app-server --listen ws://...` and speaks JSON-RPC 2.0
 * over WebSocket. We only model the subset Hivemind interacts with directly.
 */

export type JsonRpcId = number | string;

export interface CodexRequest<M extends string = string, P = unknown> {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: M;
  params?: P;
}

export interface CodexResponse<R = unknown> {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexNotification<M extends string = string, P = unknown> {
  jsonrpc?: "2.0";
  id?: undefined;
  method: M;
  params?: P;
}

// ── Tracked methods (we record these requests so we can interpret responses) ──

export const TRACKED_REQUEST_METHODS = ["thread/start", "thread/resume", "turn/start"] as const;
export type TrackedRequestMethod = typeof TRACKED_REQUEST_METHODS[number];
const TRACKED_SET = new Set<string>(TRACKED_REQUEST_METHODS);

export function isTrackedMethod(method: unknown): method is TrackedRequestMethod {
  return typeof method === "string" && TRACKED_SET.has(method);
}

// ── Notification methods we care about ──

export const NOTIFICATION_METHODS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/agentMessage/delta",
  "item/completed",
] as const;
export type NotificationMethod = typeof NOTIFICATION_METHODS[number];
const NOTIFICATION_SET = new Set<string>(NOTIFICATION_METHODS);

// ── Item types ──

export interface CodexContentPart {
  type: string;
  text?: string;
}

export interface CodexItem {
  id: string;
  type: string;
  content?: CodexContentPart[];
}

// ── Turn input ──

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }>;
}

// ── Type guards ──

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRequest(v: unknown): v is CodexRequest {
  if (!isObj(v)) return false;
  const id = v.id;
  return (typeof id === "number" || typeof id === "string") && typeof v.method === "string";
}

export function isResponse(v: unknown): v is CodexResponse {
  if (!isObj(v)) return false;
  const id = v.id;
  if (typeof id !== "number" && typeof id !== "string") return false;
  if (v.method !== undefined) return false;
  return "result" in v || "error" in v;
}

export function isNotification(v: unknown): v is CodexNotification {
  if (!isObj(v)) return false;
  if (v.id !== undefined) return false;
  return typeof v.method === "string";
}

/** Whether the proxy needs to inspect a notification (vs. just forwarding it). */
export function isHandledNotification(method: string): boolean {
  return NOTIFICATION_SET.has(method);
}

/** Concatenate the text portion of a Codex item's content array. */
export function extractItemText(item: CodexItem): string {
  if (!item.content?.length) return "";
  return item.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
}

/** Coerce any JSON-RPC id to a number, returning NaN for non-numeric strings. */
export function numericId(id: unknown): number {
  if (typeof id === "number") return id;
  if (typeof id === "string" && /^-?\d+$/.test(id)) return Number(id);
  return NaN;
}
