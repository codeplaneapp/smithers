/**
 * A real Smithers sandbox provider backed by a booted stereOS mixtape VM.
 *
 * The whole provider is the SandboxSession seam plus SSH. Everything else —
 * request shipping, the env contract, result parsing, secret scrubbing,
 * cleanup — is `createCommandSandboxProvider` from the shipped
 * `smthrs/sandbox` package.
 *
 * The VM is booted and keyed by masterblaster (`mb up`), which injects the
 * SSH key over the stereosd vsock control plane. Point the provider at it with:
 *
 *   STEREOS_SSH_HOST  host running sshd            (default 127.0.0.1)
 *   STEREOS_SSH_PORT  forwarded guest sshd port    (default 2222)
 *   STEREOS_SSH_KEY   private key path             (default ~/.config/stereos/ssh-key)
 *   STEREOS_SSH_USER  guest user                   (default agent)
 */
import { createCommandSandboxProvider } from "smthrs/sandbox";
import type { SandboxSession } from "smthrs/sandbox";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? "";

export const WORKDIR = "/home/agent/workspace";
const RUNNER_PATH = `${WORKDIR}/.smithers/guest-runner.sh`;
const WORKFLOW_PATH = `${WORKDIR}/.smithers/child-workflow.js`;

const SSH_HOST = process.env.STEREOS_SSH_HOST ?? "127.0.0.1";
const SSH_PORT = process.env.STEREOS_SSH_PORT ?? "2222";
const SSH_KEY = process.env.STEREOS_SSH_KEY ?? `${HOME}/.config/stereos/ssh-key`;
const SSH_USER = process.env.STEREOS_SSH_USER ?? "agent";

const SSH_ARGS = [
  "-p",
  SSH_PORT,
  "-i",
  SSH_KEY,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "ConnectTimeout=10",
  `${SSH_USER}@${SSH_HOST}`,
];

/** Single-quote a value for the guest shell. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function ssh(cmd: string, stdin?: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, cmd], {
    stdin: stdin === undefined ? "ignore" : (new Response(stdin).body ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      proc.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process exited after SIGTERM.
        }
      }, 1_000);
    } catch {
      // The process may have exited between the signal and this callback.
    }
  };
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    : undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (aborted) throw new DOMException("stereOS SSH transport aborted", "AbortError");
    if (timedOut) throw new Error(`stereOS SSH transport timed out after ${opts.timeoutMs} ms`);
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function buildGuestWorkflow() {
  const result = await Bun.build({
    entrypoints: [join(HERE, "child-workflow.tsx")],
    target: "bun",
    format: "esm",
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`failed to bundle the guest child workflow: ${result.logs.map(String).join("\n")}`);
  }
  return result.outputs[0].text();
}

/** Prove the VM answers before a run commits to it. */
export async function probeVm() {
  return ssh("id -un; uname -srm");
}

export const stereosProvider = createCommandSandboxProvider({
  id: "stereos",
  workdir: WORKDIR,
  // The host uploads this tiny launcher and a bundle of child-workflow.tsx.
  // bootstrap-vm.sh/run-on-linux-host.sh install the official static Bun build.
  command: `sh ${RUNNER_PATH}`,
  cleanup: "keep", // VM lifecycle stays with `mb up` / `mb down`.
  async createSession(request): Promise<SandboxSession> {
    const session: SandboxSession = {
      remoteId: `stereos-${request.sandboxId}`,
      async writeFile(path, content) {
        const r = await ssh(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, content, {
          signal: request.signal,
          timeoutMs: 30_000,
        });
        if (r.exitCode !== 0) throw new Error(`stereos writeFile ${path} failed: ${r.stderr.trim()}`);
      },
      async readFile(path) {
        const r = await ssh(`cat ${q(path)}`, undefined, { signal: request.signal, timeoutMs: 30_000 });
        if (r.exitCode !== 0) throw new Error(`stereos readFile ${path} failed: ${r.stderr.trim()}`);
        return r.stdout;
      },
      async exec(command, opts) {
        const env = Object.entries(opts.env)
          .map(([k, v]) => `${k}=${q(String(v))}`)
          .join(" ");
        const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
        return ssh(`cd ${q(opts.cwd)} && env ${env} timeout ${seconds}s sh -c ${q(command)}`, undefined, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs + 5_000,
        });
      },
    };
    // Upload the entry runner alongside the request the kit is about to write.
    await session.writeFile(RUNNER_PATH, readFileSync(join(HERE, "guest-runner.sh"), "utf8"));
    await session.writeFile(WORKFLOW_PATH, await buildGuestWorkflow());
    return session;
  },
});
