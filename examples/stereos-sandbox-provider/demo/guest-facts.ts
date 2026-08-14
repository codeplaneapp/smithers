/**
 * Facts only the guest can report, collected inside the stereOS VM.
 *
 * Every demo child workflow returns this block. The page renders it as the
 * evidence that the body ran in the VM and not on the host: the host is Debian
 * on GCE, the guest is stereOS with the `coder-dev` hostname and a NixOS store.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const guestFactsSchema = z.object({
  os: z.string(),
  kernel: z.string(),
  user: z.string(),
  hostname: z.string(),
  arch: z.string(),
  bun: z.string(),
  cpus: z.number(),
  memTotalKb: z.number(),
  uptimeSeconds: z.number(),
  nixStorePresent: z.boolean(),
  writeOutsideWorkspace: z.string(),
});

export type GuestFacts = z.infer<typeof guestFactsSchema>;

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
          return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")];
        }),
    );
    return `${fields.NAME ?? "unknown"} ${fields.VERSION ?? ""}`.trim();
  } catch {
    return "unknown";
  }
}

/** Probe the restriction model: the agent user must not write outside its workspace. */
async function canWriteOutsideWorkspace() {
  try {
    await Bun.write("/etc/stereos-write-probe", "stereOS write probe\n");
    return "ALLOWED (unexpected)";
  } catch {
    return "denied";
  }
}

/** Collect the guest-only facts. Runs inside the VM, never on the host. */
export async function guestFacts(): Promise<GuestFacts> {
  return {
    os: osName(),
    kernel: command("uname", "-srm"),
    user: command("id", "-un"),
    hostname: command("hostname"),
    arch: process.arch,
    bun: Bun.version,
    cpus: Number(command("nproc")) || 0,
    memTotalKb: Number(command("sh", "-c", "awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null")) || 0,
    uptimeSeconds: Math.round(Number(command("sh", "-c", "cut -d' ' -f1 /proc/uptime 2>/dev/null")) || 0),
    nixStorePresent: existsSync("/nix/store"),
    writeOutsideWorkspace: await canWriteOutsideWorkspace(),
  };
}
