#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getExplicitWorkflowPath,
  findNearestLocalSmithersCli,
  findNearestWorkflowLocalCli,
} from "./smithers-delegation.js";
import { danglingWorkspaceLinkHint } from "./danglingWorkspaceLinkHint.js";

/**
 * When a project-local `smithers` install exists (the workflow pack's
 * `.smithers/node_modules`, or the project's own `node_modules`), re-exec
 * against that instead of this globally-resolved copy. This is the same
 * pattern `tsc` uses for local TypeScript installs: every module the
 * workflow runtime touches — engine, react-reconciler, components, React
 * itself — comes from a single tree, which avoids the "two React copies →
 * null useContext dispatcher" trap that bunx and `.smithers/` would
 * otherwise produce (bunx temp dir + local `.smithers/node_modules/` each
 * install their own React). Resolution prefers the tree nearest an explicit
 * workflow-path argument, then walks up from cwd like tsx/bunx so commands
 * run from project subdirectories still use the project's version.
 */
function delegateToLocalCliIfPresent() {
  const cwd = process.cwd();
  const workflowPath = getExplicitWorkflowPath(process.argv.slice(2));
  const workflowLocalBin = workflowPath ? findNearestWorkflowLocalCli(cwd, workflowPath) : null;
  const localBin = workflowLocalBin ?? findNearestLocalSmithersCli(cwd);
  if (!localBin) return false;
  const selfPath = realpathSync(fileURLToPath(import.meta.url));
  const localTarget = realpathSync(localBin);
  if (localTarget === selfPath) return false;
  const proc = spawn(process.execPath, [localTarget, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd,
  });
  proc.on("exit", (code, signal) => {
    // Windows has no signal re-raise; approximate the shell's 128+n with a
    // plain failure code so callers still see a non-zero exit.
    if (signal) {
      if (process.platform === "win32") process.exit(1);
      else process.kill(process.pid, signal);
    } else process.exit(code ?? 0);
  });
  return true;
}

if (!delegateToLocalCliIfPresent()) {
  try {
    await import("@smithers-orchestrator/cli");
  } catch (error) {
    // A dangling workspace link (e.g. rewritten to point into a removed
    // git worktree) surfaces here as a bare ENOENT import error. Name the
    // broken links and the fix before rethrowing.
    const hint = danglingWorkspaceLinkHint(dirname(fileURLToPath(import.meta.url)));
    if (hint) {
      console.error(hint);
    }
    throw error;
  }
}
