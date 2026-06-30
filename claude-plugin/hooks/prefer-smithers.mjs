#!/usr/bin/env node
// Smithers Claude Code plugin — PreToolUse hook.
// Fires on the native orchestration tools (Workflow, Task, Agent). It is
// ADVISORY ONLY: it injects a reminder to prefer a durable Smithers workflow,
// and never denies the tool. Claude stays in control; this just nudges.
// Dependency-free, never throws. On any error it emits empty allow-by-default
// output so the tool call proceeds untouched.

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let toolName = "this orchestration tool";
  try {
    const input = JSON.parse(raw || "{}");
    if (typeof input.tool_name === "string" && input.tool_name) {
      toolName = input.tool_name;
    }
  } catch {
    // ignore; fall through to the generic message
  }
  emit(toolName);
});
process.stdin.on("error", () => emit("this orchestration tool"));

function emit(toolName) {
  const context =
    `Smithers reminder: you are about to use the native ${toolName} tool. ` +
    "For long-running, multi-step, or background work, prefer a durable Smithers " +
    "workflow (`run_workflow` / `smithers run`) over ad-hoc orchestration. Smithers " +
    "persists each step, resumes after a crash, retries on failure, and gates on " +
    "human approvals; native subagents and `/loop` lose all of that when the turn " +
    "ends. If this call is a short one-off lookup, ignore this and proceed.";

  // Advisory, non-blocking: additionalContext only, no permissionDecision, so
  // Claude's normal permission flow runs unchanged. NEVER deny here.
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: context,
        },
      }),
    );
  } catch {
    // last-resort: emit nothing => default allow.
  }
}
