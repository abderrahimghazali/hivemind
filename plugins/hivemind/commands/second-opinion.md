---
description: Ask Codex for a second opinion on a question
allowed-tools: mcp__hivemind__ask_codex, mcp__hivemind__wait_for_codex, mcp__hivemind__peers
argument-hint: <question>
---

You are consulting Codex (an OpenAI coding agent running in a sibling session on this machine) for a second opinion. Codex will give independent technical judgment, not passive agreement.

Steps:

1. Call `mcp__hivemind__peers` once to confirm Codex is online. If `online` is false or `warnings` includes `unsupported_session_picker`, surface the exact error to the user (with the relaunch hint it returns) and stop.

2. Send the user's question to Codex via `mcp__hivemind__ask_codex` with `wait_ms: 60000`. The tool blocks until Codex finishes the turn or the wait elapses, and returns Codex's reply directly. You do **not** need to poll afterwards in the normal case.

3. If `ask_codex` returns `timed_out: true`, call `mcp__hivemind__wait_for_codex` with `timeout_ms: 30000` once more before giving up.

4. Present a concise comparison:
   - **Codex's answer:** quote the substance.
   - **My independent view:** state your own reasoning, then explicitly call out where you **agree** and where you **disagree** with Codex.
   - **Recommendation:** one or two sentences synthesizing both views, or a clear flag if the disagreement is unresolved.

Question: $ARGUMENTS
