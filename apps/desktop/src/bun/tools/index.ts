import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { applyPatch } from "diff";
import { assertPathWithinRoot, resolveSandboxPath, truncateToBytes } from "./sandbox";

export type ToolOutput = {
  output: string;
  details?: Record<string, unknown>;
};

export type ToolRunnerOptions = {
  rootDir: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT = 60_000;

export class ToolRunner {
  private rootDir: string;
  private maxOutputBytes: number;
  private timeoutMs: number;

  constructor(opts: ToolRunnerOptions) {
    this.rootDir = opts.rootDir;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  async read(path: string): Promise<ToolOutput> {
    const resolved = resolveSandboxPath(this.rootDir, path);
    await assertPathWithinRoot(this.rootDir, resolved);
    const stats = await fs.stat(resolved);
    if (stats.size > this.maxOutputBytes) {
      throw new Error(`File too large (${stats.size} bytes)`);
    }
    const content = await fs.readFile(resolved, "utf8");
    return { output: truncateToBytes(content, this.maxOutputBytes) };
  }

  async write(path: string, content: string): Promise<ToolOutput> {
    const resolved = resolveSandboxPath(this.rootDir, path);
    await assertPathWithinRoot(this.rootDir, resolved);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxOutputBytes) {
      throw new Error(`Content too large (${bytes} bytes)`);
    }
    await fs.mkdir(dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return { output: "ok", details: { bytes } };
  }

  async edit(path: string, patch: string): Promise<ToolOutput> {
    const resolved = resolveSandboxPath(this.rootDir, path);
    await assertPathWithinRoot(this.rootDir, resolved);
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchBytes > this.maxOutputBytes) {
      throw new Error(`Patch too large (${patchBytes} bytes)`);
    }
    const stats = await fs.stat(resolved);
    if (stats.size > this.maxOutputBytes) {
      throw new Error(`File too large (${stats.size} bytes)`);
    }
    const current = await fs.readFile(resolved, "utf8");
    const updated = applyPatch(current, patch);
    if (updated === false) {
      throw new Error("Failed to apply patch");
    }
    await fs.writeFile(resolved, updated, "utf8");
    return { output: "ok", details: { bytes: Buffer.byteLength(updated, "utf8") } };
  }

  async bash(command: string): Promise<ToolOutput> {
    if (!isCommandSafe(command)) {
      throw new Error("Network access is disabled for bash commands.");
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;

    const child = spawn(command, {
      cwd: this.rootDir,
      shell: true,
      env: {
        ...process.env,
        SMITHERS_BASH_SANDBOX: "1",
      },
      detached: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, this.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > this.maxOutputBytes) {
        stdout = stdout.slice(0, this.maxOutputBytes);
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > this.maxOutputBytes) {
        stderr = stderr.slice(0, this.maxOutputBytes);
      }
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    clearTimeout(timer);

    if (timedOut) {
      throw new Error(`Command timed out after ${this.timeoutMs}ms`);
    }

    const output = truncateToBytes(stdout.toString("utf8"), this.maxOutputBytes);
    const err = truncateToBytes(stderr.toString("utf8"), this.maxOutputBytes);

    return {
      output: output || err || "",
      details: { stdout: output, stderr: err, exitCode },
    };
  }
}

function isCommandSafe(command: string): boolean {
  const lowered = command.toLowerCase();
  const blocked = [
    "curl ",
    "wget ",
    "http://",
    "https://",
    "ssh ",
    "scp ",
    "nc ",
    "netcat",
    "telnet",
    "ftp ",
    "sftp ",
    "git ",
  ];
  return !blocked.some((token) => lowered.includes(token));
}
