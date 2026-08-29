const POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 2000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

export async function killProcess(
  handle: { pid: number },
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  const { pid } = handle;
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    throw new Error(`killProcess: invalid pid ${String(pid)}`);
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      throw new Error(
        `killProcess: pid ${pid} is already dead (ESRCH on initial ${signal}); fault was not actually injected`,
      );
    }
    throw error;
  }
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `killProcess: pid ${pid} did not exit within ${DEFAULT_TIMEOUT_MS}ms after ${signal}`,
  );
}
