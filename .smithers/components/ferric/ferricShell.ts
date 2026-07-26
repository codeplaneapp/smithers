/**
 * The deterministic layer's shell helpers.
 *
 * Everything the campaign treats as *evidence* runs through here: real commands,
 * asynchronously (never `spawnSync`, which would block the engine's event loop
 * and starve concurrent agents' heartbeats through a 90-minute oracle run).
 */

/** The executable contract M0 must author before any slice work is admitted. */
export const SCRIPTS = [
  "scripts/ferric/oracle.sh", // --unmodified | --ratchet | --all | --leg <x> → "PASSING=n/m [XFAIL_C=k]"
  "scripts/ferric/slice-suite.sh", // <sliceId> → "PASSING=n/m"
  "scripts/ferric/bench.sh", // <name> → "RATIO_X1000=n"
  "scripts/ferric/fuzz.sh", // <mode> --cases N → "CASES=n DIVERGENCES=m"
  "scripts/ferric/leaks.sh", // --cycles N --ssr-requests N → exit status
  "scripts/ferric/publish.sh", // <artifact> <idempotencyKey>
];

export type ShellResult = {
  code: number;
  ok: boolean;
  out: string;
  err: string;
};

export async function sh(cmd: string[], cwd?: string): Promise<ShellResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, ok: code === 0, out: out.slice(-8000), err: err.slice(-8000) };
}

/**
 * Infra-vs-red discrimination (spec §1.5). An out-of-memory kill or a timeout is
 * never semantic evidence, so it throws — the task retries with headroom instead
 * of minting a false red that would halt the queue.
 */
export function assertNotInfra(r: ShellResult, what: string): void {
  const text = `${r.out}\n${r.err}`;
  if (
    [124, 137, 143].includes(r.code) ||
    /out of memory|OOM|Killed: 9|ETIMEDOUT/i.test(text)
  ) {
    throw new Error(
      `INFRA_RETRY(${what}): exit ${r.code} — retrying with headroom, not a red`,
    );
  }
}

export const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
