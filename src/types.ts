export type AgentSource = "claude" | "codex";

export interface HivemindMessage {
  id: string;
  source: AgentSource;
  content: string;
  ts: number;
}

export interface PeerInfo {
  name: "codex";
  online: boolean;
  threadId: string | null;
  warnings: string[];
}
