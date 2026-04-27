---
description: Brainstorm a topic with Codex over multiple rounds
allowed-tools: mcp__hivemind__ask_codex, mcp__hivemind__wait_for_codex, mcp__hivemind__peers
argument-hint: <topic>
---

You are brainstorming a topic with Codex. Goal: explore the topic together over up to 3 rounds, then converge on a recommendation.

Setup: call `mcp__hivemind__peers` once. If Codex is offline or reports `unsupported_session_picker`, surface the error and stop.

Round structure (repeat up to 3 times, fewer if you reach consensus or hit a hard disagreement):

1. State your current view in 2-4 sentences. Tag a key conclusion with `[IMPORTANT]` if you have one — this is a hint to Codex, not a routing rule.
2. Send your view to Codex via `mcp__hivemind__ask_codex` with `wait_ms: 90000`. The tool returns Codex's reply.
3. If you got a reply: identify points of agreement and points of disagreement explicitly. Use phrases like "I agree on:", "I disagree on:", "Current consensus:".
4. Decide whether to continue:
   - Stop early if you have **converged** (both sides agree on a path).
   - Stop early if the disagreement is **substantive and unresolved** — that itself is the answer.
   - Otherwise, run another round.

Final summary (always):

- **Convergent ideas:** what you both agree on.
- **Divergent ideas:** what you disagree on, with the strongest argument from each side.
- **Recommended next step:** one concrete action.

Topic: $ARGUMENTS
