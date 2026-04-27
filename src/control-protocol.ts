import type { HivemindMessage, PeerInfo } from "./types";

export interface DaemonStatus {
  codexConnected: boolean;
  threadId: string | null;
  pickerActive: boolean;
  queuedMessages: number;
  pid: number;
}

export type ControlClientMessage =
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | {
      type: "ask_codex";
      requestId: string;
      text: string;
      /** When > 0, daemon waits up to waitMs for the resulting turn to complete and returns replies. */
      waitMs?: number;
    }
  | { type: "peers_request"; requestId: string }
  | { type: "status_request" };

export interface AskResultOk {
  ok: true;
  /** Concatenated agentMessage text emitted during the turn. Empty if waitMs was 0 or the wait timed out before any message. */
  reply: string;
  /** Individual agentMessages collected during the wait. */
  parts: string[];
  /** True if the wait timed out before turn/completed fired. */
  timedOut: boolean;
}

export interface AskResultErr {
  ok: false;
  error: string;
  /** Stable error code for callers to branch on. */
  errorCode?: "PICKER_DETECTED" | "TURN_BUSY" | "NO_THREAD" | "NOT_CONNECTED" | "SEND_FAILED" | "TIMEOUT";
}

export type AskResult = AskResultOk | AskResultErr;

export type ControlServerMessage =
  | { type: "codex_message"; message: HivemindMessage }
  | { type: "ask_result"; requestId: string; result: AskResult }
  | { type: "peers_result"; requestId: string; peers: PeerInfo[] }
  | { type: "status"; status: DaemonStatus };

/** WebSocket close code: another Claude session has taken the slot. */
export const CLOSE_CODE_REPLACED = 4001;

/** WebSocket close code: secondary (picker) connection refused. */
export const CLOSE_CODE_PICKER_REFUSED = 4002;
