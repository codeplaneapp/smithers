import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { killProcess } from "./killProcess.ts";

function spawnIdleChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("killProcess", () => {
  test("SIGKILL terminates a long-running child", async () => {
    const child = spawnIdleChild();
    expect(typeof child.pid).toBe("number");
    const pid = child.pid as number;
    expect(pidIsAlive(pid)).toBe(true);

    await killProcess({ pid });

    expect(pidIsAlive(pid)).toBe(false);
    await waitForExit(child);
  });

  test("SIGTERM terminates a long-running child", async () => {
    const child = spawnIdleChild();
    const pid = child.pid as number;
    expect(pidIsAlive(pid)).toBe(true);

    await killProcess({ pid }, "SIGTERM");

    expect(pidIsAlive(pid)).toBe(false);
    await waitForExit(child);
  });

  test("rejects with a clear error when the process is already dead", async () => {
    const child = spawnIdleChild();
    const pid = child.pid as number;
    child.kill("SIGKILL");
    await waitForExit(child);
    while (pidIsAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(killProcess({ pid })).rejects.toThrow(/already dead/);
  });
});
