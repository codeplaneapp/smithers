/** @jsxImportSource smthrs */
/**
 * The child workflow that runs inside the stereOS guest.
 *
 * The provider bundles this exact module on the host, uploads that bundle, and
 * guest-runner.sh executes it with the guest's Bun binary. The Task and the
 * protocol entrypoint call the same executeGuestWork function.
 */
import { createSmithers } from "smthrs";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { z } from "zod";

export const guestResultSchema = z.object({
  summary: z.string(),
  prompt: z.string(),
  promptSha256: z.string(),
  guest: z.record(z.string(), z.unknown()),
  restrictions: z.record(z.string(), z.string()),
  harnessesOnPath: z.string(),
  execution: z.object({
    workflow: z.string(),
    runtime: z.string(),
    jsonEmitter: z.string(),
    jqOnPath: z.boolean(),
  }),
  computation: z.object({
    upperBound: z.number(),
    primeCount: z.number(),
    primeSum: z.number(),
    lastPrime: z.number(),
  }),
  runId: z.string(),
  sandboxId: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ prompt: z.string() }),
  result: guestResultSchema,
});

function command(...argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return "";
  return result.stdout.toString().trim();
}

function osName() {
  try {
    const fields = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .filter((line: string) => line.includes("="))
        .map((line: string) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1).replace(/^['\"]|['\"]$/g, "")];
        }),
    );
    return `${fields.NAME ?? "unknown"} ${fields.VERSION ?? ""}`.trim();
  } catch {
    return "unknown";
  }
}

function primesThrough(upperBound: number) {
  const composite = new Uint8Array(upperBound + 1);
  let primeCount = 0;
  let primeSum = 0;
  let lastPrime = 0;
  for (let candidate = 2; candidate <= upperBound; candidate += 1) {
    if (composite[candidate]) continue;
    primeCount += 1;
    primeSum += candidate;
    lastPrime = candidate;
    if (candidate * candidate <= upperBound) {
      for (let multiple = candidate * candidate; multiple <= upperBound; multiple += candidate) {
        composite[multiple] = 1;
      }
    }
  }
  return { upperBound, primeCount, primeSum, lastPrime };
}

async function canWrite(path: string) {
  try {
    await Bun.write(path, "stereOS write probe\n");
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** The non-trivial child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(prompt: string, protocol: { runId: string; sandboxId: string }) {
  const promptBytes = new TextEncoder().encode(prompt);
  const upperBound = 20_000 + (promptBytes.reduce((sum, byte) => sum + byte, 0) % 5_000);
  const kernel = command("uname", "-srm");
  const user = command("id", "-un");
  const hostname = command("hostname");
  const uptimeSeconds = Number((await Bun.file("/proc/uptime").text()).split(/\s+/)[0] ?? 0);
  const memTotalKb = Number((await Bun.file("/proc/meminfo").text()).match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
  const harnesses = ["claude", "opencode", "gemini"].filter((name) => Boolean(Bun.which(name)));
  const promptSha256 = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");

  return {
    summary: `child workflow executed inside stereOS as ${user}@${hostname} on ${kernel}`,
    prompt,
    promptSha256,
    guest: {
      os: osName(),
      kernel,
      user,
      hostname,
      uptimeSeconds,
      cpus: Number(command("nproc")) || 0,
      memTotalKb,
    },
    restrictions: {
      writeOutsideWorkspace: (await canWrite("/etc/stereos-write-probe")) ? "ALLOWED (unexpected)" : "denied",
      writeInsideWorkspace: (await canWrite(`${process.env.HOME}/workspace/.stereos-write-probe`))
        ? "allowed"
        : "DENIED (unexpected)",
      nixCli: Bun.which("nix") ? "on PATH" : "not on PATH",
      nixStorePresent: existsSync("/nix/store") ? "yes" : "no",
    },
    harnessesOnPath: harnesses.join(" ") || "none-on-path",
    execution: {
      workflow: "stereos-guest-work/guest-facts",
      runtime: `Bun ${Bun.version} ${process.arch}`,
      jsonEmitter: "Bun JSON.stringify",
      jqOnPath: Boolean(Bun.which("jq")),
    },
    computation: primesThrough(upperBound),
    runId: protocol.runId,
    sandboxId: protocol.sandboxId,
  };
}

export default smithers((ctx) => (
  <Workflow name="stereos-guest-work">
    <Task id="guest-facts" output={outputs.result}>
      {() => executeGuestWork(ctx.input.prompt, { runId: "smithers-child", sandboxId: "stereos-vm" })}
    </Task>
  </Workflow>
));

// createCommandSandboxProvider writes the request path into the environment.
// Bun runs this bundled module as the guest entrypoint and this branch writes
// the provider result. Importing the module on the host does not enter it.
if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const prompt = z.string().parse(request.input?.prompt);
  const output = await executeGuestWork(prompt, {
    runId: z.string().parse(request.runId),
    sandboxId: z.string().parse(request.sandboxId),
  });
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(`${result}\n`);
}
