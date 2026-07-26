import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveGitBinary } from "@smithers-orchestrator/vcs";

/**
 * Resolve Git once when the runner module loads. Workflows may temporarily
 * adjust PATH while tasks execute; an already-running engine must keep using
 * the executable it admitted during startup.
 *
 * @returns {string}
 */
function resolveGitExecutable() {
  const configured = resolveGitBinary().path;
  if (configured !== "git") return configured;
  const bunRuntime = typeof Bun !== "undefined" ? Bun : null;
  if (typeof bunRuntime?.which === "function") {
    return bunRuntime.which("git") ?? configured;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    if (existsSync(candidate)) return candidate;
  }
  return configured;
}

const gitBinary = resolveGitExecutable();

/**
 * Spawn `git` in `cwd` and collect its output. Never rejects: a missing binary
 * surfaces as exit code 127 so callers branch on `code` alone.
 *
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
export function runGit(cwd, args) {
  return new Promise((res) => {
    const child = spawn(gitBinary, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => res({ code: 127, stdout: "", stderr: err.message }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}
