import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZMUXD_PATH } from "./zmuxBin.ts";
import { waitForSocket } from "./zmuxWait.ts";

export type ZmuxDaemon = {
  socketPath: string;
  process: ReturnType<typeof Bun.spawn>;
  dispose(): Promise<void>;
};

/**
 * Boot a private zmuxd for one test file: `--idle-seconds 0` (never
 * self-exit), a short socket path under /private/tmp (sun_path is ~104
 * bytes; NOT the deep scratchpad tmpdir). An instant exit 0 means a live
 * daemon already answers on that socket (it exits WITHOUT serving) — since
 * we mint a fresh unique path every call, that would mean a stale daemon is
 * squatting on it, which is always a bug, never expected.
 */
export async function startDaemon(): Promise<ZmuxDaemon> {
  const bin = ZMUXD_PATH;
  if (!bin) throw new Error("zmuxd binary not found; guard callers with describeZmux");

  const dir = mkdtempSync(join(tmpdir(), "zmux-e2e-"));
  const socketPath = join(dir, "s.sock");

  const child = Bun.spawn([bin, "--socket", socketPath, "--idle-seconds", "0"], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  const exitedEarly = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (exitedEarly) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`zmuxd exited immediately (code ${child.exitCode}); socket ${socketPath} already owned`);
  }

  await waitForSocket(socketPath, 2000);

  return {
    socketPath,
    process: child,
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(2000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
