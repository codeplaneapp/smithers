import { spawn } from "node:child_process";
import { resolveGitBinary } from "@smithers-orchestrator/vcs";

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
        const child = spawn(resolveGitBinary().path, [...args], {
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
