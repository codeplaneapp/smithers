#!/usr/bin/env node
// Smithers Claude Code plugin: the PreToolUse hook.
// Fires on the native orchestration tools (Workflow, Task, Agent). It is
// ADVISORY ONLY: it injects a reminder to prefer a durable Smithers workflow,
// and never denies the tool. Claude stays in control; this just nudges.
// The one sanctioned native-Workflow use, the plugin's smithers-run.mjs
// /workflows mirror, passes through with no nudge at all.
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
    if (isSmithersMirrorLaunch(input)) {
      // The mirror IS the smithers path; stay silent so nothing second-guesses it.
      process.stdout.write("{}");
      return;
    }
    if (typeof input.tool_name === "string" && input.tool_name) {
      toolName = input.tool_name;
    }
  } catch {
    // ignore; fall through to the generic message
  }
  emit(toolName);
});
process.stdin.on("error", () => emit("this orchestration tool"));

function isSmithersMirrorLaunch(input) {
  if (input?.tool_name !== "Workflow") {
    return false;
  }
  const toolInput = input.tool_input ?? {};
  const scriptPath = typeof toolInput.scriptPath === "string" ? toolInput.scriptPath : "";
  const name = typeof toolInput.name === "string" ? toolInput.name : "";
  return scriptPath.includes("smithers-run.mjs") || name === "smithers-run";
}

function emit(toolName) {
  const context =
    `Smithers reminder: you are about to use the native ${toolName} tool. ` +
    "For genuinely multi-stage, approval-gated, or reusable work, prefer a durable Smithers " +
    "flow (`run_workflow`, or `smithers up`) over ad-hoc orchestration, and give it " +
    "a live view by launching the plugin's smithers-run.mjs mirror through the Workflow " +
    "tool instead of a hand-written script. Smithers records each step, resumes after " +
    "a crash, retries on failure, and parks on human approvals; native subagents and " +
    "`/loop` lose all of that when the turn ends. If this call is a short one-off " +
    "lookup, ignore this and proceed.";

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
