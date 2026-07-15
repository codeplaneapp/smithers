// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const commandProbeOutputSchema = z.looseObject({
  command: z.string(),
  available: z.boolean(),
});

function executableAvailable(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0];
  if (!executable) return false;
  const lookup = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
    : "/usr/bin/which";
  return spawnSync(lookup, [executable], { stdio: "ignore", shell: false }).status === 0;
}

export function CommandProbe({ id, command }: { id: string; command: string }) {
  return (
    <Task id={id} output={commandProbeOutputSchema}>
      {{ command, available: executableAvailable(command) }}
    </Task>
  );
}
