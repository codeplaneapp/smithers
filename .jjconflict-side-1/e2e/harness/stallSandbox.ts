import { rename } from "node:fs/promises";
import type { SandboxHandle } from "@smithers-orchestrator/sandbox/SandboxHandle";

const STALL_SUFFIX = ".stalled";

export async function stallSandbox(
  handle: SandboxHandle,
  durationMs: number,
): Promise<{ release: () => Promise<void> }> {
  const original = handle.requestPath;
  const stalled = `${original}${STALL_SUFFIX}`;
  await rename(original, stalled);

  let released = false;
  const restore = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    await rename(stalled, original).catch(() => undefined);
  };

  const timer = setTimeout(() => {
    void restore();
  }, durationMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    release: () => restore(),
  };
}
