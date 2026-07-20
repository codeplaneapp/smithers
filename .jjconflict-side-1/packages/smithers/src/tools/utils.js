import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, realpath, stat } from "node:fs/promises";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import {
  assertPathWithinRoot,
  resolveSandboxPath,
} from "@smithers-orchestrator/sandbox/sandboxPath";
import { getToolContext } from "./context.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export function getToolRuntimeOptions() {
  const ctx = getToolContext();
  return {
    ctx,
    rootDir: ctx?.rootDir ?? process.cwd(),
    allowNetwork: ctx?.allowNetwork ?? false,
    maxOutputBytes: ctx?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: ctx?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8BoundaryLength(buf, byteLength) {
  let end = Math.min(byteLength, buf.length);
  if (end >= buf.length) {
    return buf.length;
  }
  // If the cut lands on a continuation byte, back up to the lead byte of the
  // partial sequence so we never decode an incomplete codepoint.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

export function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  return buf.subarray(0, utf8BoundaryLength(buf, maxBytes)).toString("utf8");
}

export async function resolveToolPath(rootDir, inputPath) {
  const resolved = resolveSandboxPath(rootDir, inputPath);
  await assertPathWithinRoot(rootDir, resolved);
  return resolved;
}

export async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

export async function assertReadableFileWithinLimit(path, maxBytes) {
  const fileStat = await stat(path);
  if (Number(fileStat.size) > maxBytes) {
    throw new SmithersError(
      "TOOL_FILE_TOO_LARGE",
      `File too large (${fileStat.size} bytes)`,
    );
  }
}

export async function canonicalRoot(rootDir) {
  return realpath(rootDir);
}

function appendLimited(chunks, state, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.totalBytes += buffer.length;
  const remaining = maxBytes - state.storedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (buffer.length <= remaining) {
    chunks.push(buffer);
    state.storedBytes += buffer.length;
    return;
  }
  const accepted = utf8BoundaryLength(buffer, remaining);
  if (accepted > 0) {
    chunks.push(buffer.subarray(0, accepted));
    state.storedBytes += accepted;
  }
  state.truncated = true;
}

export function captureProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    detached = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = {
      storedBytes: 0,
      totalBytes: 0,
      truncated: false,
    };
    const stderrState = {
      storedBytes: 0,
      totalBytes: 0,
      truncated: false,
    };
    let settled = false;
    let timer;

    const child = spawn(command, args, {
      cwd,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      fn();
    };

    const kill = () => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        kill();
        finish(() =>
          reject(
            new SmithersError(
              "PROCESS_TIMEOUT",
              `Command timed out after ${timeoutMs}ms`,
              { command, args, cwd, timeoutMs },
            ),
          ),
        );
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      appendLimited(stdoutChunks, stdoutState, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      appendLimited(stderrChunks, stderrState, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      finish(() =>
        reject(
          new SmithersError("PROCESS_FAILED", `Failed to spawn ${command}`, {
            command,
            args,
            cwd,
          }, { cause: error }),
        ),
      );
    });
    child.on("close", (exitCode, signal) => {
      finish(() => {
        resolve({ exitCode: exitCode ?? (signal ? 1 : 0), signal, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), truncated: stdoutState.truncated || stderrState.truncated, totalBytes: stdoutState.totalBytes + stderrState.totalBytes });
      });
    });
  });
}
