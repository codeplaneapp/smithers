// A SandboxProvider built from the same provider kit the proposed stereOS
// provider would use.
//
// The stereOS provider boots a NixOS microVM and reaches it over SSH. This one
// keeps the identical seam — createCommandSandboxProvider plus a SandboxSession
// of writeFile / readFile / exec / destroy — and swaps only the transport: exec
// runs as a child process inside the WebContainer, because a browser cannot
// boot QEMU. Everything above the session (request shipping, egress env, result
// parsing, secret scrubbing, cleanup) is shipped Smithers code, unmodified.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCommandSandboxProvider } from "smthrs/sandbox";

/** Node needs the loader shims to run smithers; Bun does not. */
const NODE_PREFIX = ["--import", "./shims/register.mjs", "--import", "tsx"];

export type InContainerProviderOptions = {
  /** Directory holding node_modules and shims/ — the mounted project root. */
  projectDir: string;
  id?: string;
  onLog?: (line: string) => void;
};

/**
 * Run one command in the container and collect its output.
 *
 * @param command Shell-style command string, as the provider kit supplies it.
 */
function execInContainer(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
  projectDir: string,
  onLog?: (line: string) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // The kit's default entry is "smithers up bundle.tsx". Under Node the bin's
  // bun shebang does not apply, so invoke it through node with the shims.
  const parts = command.trim().split(/\s+/);
  const argv =
    parts[0] === "smithers"
      ? [...NODE_PREFIX, join(projectDir, "node_modules/smthrs/src/bin/smithers.js"), ...parts.slice(1)]
      : [...NODE_PREFIX, ...parts.slice(1)];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, SMITHERS_BACKEND: "pglite" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });

    child.stdout.on("data", (d) => {
      stdout += d;
      onLog?.(String(d));
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      onLog?.(String(d));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Build the in-container provider.
 *
 * @param options Project root plus optional id and log sink.
 */
export function createInContainerSandboxProvider(options: InContainerProviderOptions) {
  const projectDir = options.projectDir;
  return createCommandSandboxProvider({
    id: options.id ?? "webcontainer-exec",
    // Same entry command the shipped providers use.
    command: "smithers up bundle.tsx",
    workdir: projectDir,
    cleanup: "destroy",
    createSession: async (request) => {
      // One scratch directory per sandbox stands in for the microVM's rootfs.
      const root = await mkdtemp(join(tmpdir(), "stereos-sandbox-"));
      options.onLog?.(`[sandbox] session ${request.sandboxId} at ${root}\n`);
      return {
        remoteId: root,
        async writeFile(path: string, content: string) {
          const target = path.startsWith("/") ? path : join(root, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        },
        async readFile(path: string) {
          const target = path.startsWith("/") ? path : join(root, path);
          return await readFile(target, "utf8");
        },
        exec: (command, execOpts) =>
          execInContainer(command, { ...execOpts, cwd: root }, projectDir, options.onLog),
        async destroy() {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
}
