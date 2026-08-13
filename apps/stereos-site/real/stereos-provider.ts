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

async function ssh(cmd: string, stdin?: string) {
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, cmd], {
    stdin: stdin === undefined ? "ignore" : (new Response(stdin).body ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Prove the VM answers before a run commits to it. */
export async function probeVm() {
  return ssh("id -un; uname -srm");
}

export const stereosProvider = createCommandSandboxProvider({
  id: "stereos",
  workdir: WORKDIR,
  // Mixtapes ship agent harnesses, not Bun or Node, so the entry is a POSIX
  // shell runner uploaded with the request. See real/README.md.
  command: `sh ${RUNNER_PATH}`,
  cleanup: "keep", // VM lifecycle stays with `mb up` / `mb down`.
  async createSession(request): Promise<SandboxSession> {
    const session: SandboxSession = {
      remoteId: `stereos-${request.sandboxId}`,
      async writeFile(path, content) {
        const r = await ssh(`mkdir -p $(dirname ${q(path)}) && cat > ${q(path)}`, content);
        if (r.exitCode !== 0) throw new Error(`stereos writeFile ${path} failed: ${r.stderr.trim()}`);
      },
      async readFile(path) {
        const r = await ssh(`cat ${q(path)}`);
        if (r.exitCode !== 0) throw new Error(`stereos readFile ${path} failed: ${r.stderr.trim()}`);
        return r.stdout;
      },
      async exec(command, opts) {
        const env = Object.entries(opts.env)
          .map(([k, v]) => `${k}=${q(String(v))}`)
          .join(" ");
        const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
        return ssh(`cd ${q(opts.cwd)} && env ${env} timeout ${seconds} ${command}`);
      },
    };
    // Upload the entry runner alongside the request the kit is about to write.
    await session.writeFile(RUNNER_PATH, readFileSync(join(HERE, "guest-runner.sh"), "utf8"));
    return session;
  },
});
