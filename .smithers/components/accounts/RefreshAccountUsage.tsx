/** @jsxImportSource smithers-orchestrator */
import { Task } from "smithers-orchestrator";
import { z } from "zod";
import { SNAPSHOT_PATH, writeSnapshot, type AccountUsage } from "./accountPool";

/**
 * Probe every registered account's live quota and write the snapshot that
 * render-time seat selection reads.
 *
 * Render is synchronous and must never hit the network, so the probe lives in a
 * compute Task and selection reads its file. Mount this at the START of a phase
 * so ordering reflects reality rather than whatever was true hours ago.
 *
 * The probe never throws: an unreachable account degrades to an `error` entry
 * and sorts last. A usage endpoint being down is not a reason to stop a
 * campaign.
 */
export const accountUsageSchema = z.object({
  snapshotPath: z.string().min(4),
  accountCount: z.number().int(),
  claudeCount: z.number().int(),
  codexCount: z.number().int(),
  summary: z.string().min(2),
});

/**
 * `output` is a prop because output schemas must be registered with the host
 * workflow's `createSmithers()` call — a component cannot invent its own table.
 * Register `accountUsageSchema` under any key and pass `outputs.<key>` here.
 */
export function RefreshAccountUsage({
  id = "accounts:refresh",
  output,
}: {
  id?: string;
  output: unknown;
}) {
  return (
    <Task id={id} output={output as any} retries={1}>
      {async () => {
        const { listAccounts } = await import("@smithers-orchestrator/accounts");
        const { getAccountUsage } = await import("@smithers-orchestrator/usage");

        const accounts = listAccounts();
        const probed: AccountUsage[] = await Promise.all(
          accounts.map(async (a: any) => {
            const base = {
              label: a.label,
              provider: a.provider,
              configDir: a.configDir,
              model: a.model,
            };
            try {
              const report: any = await getAccountUsage(a);
              return {
                ...base,
                windows: report?.windows ?? [],
                error: report?.error ?? null,
                fetchedAt: report?.fetchedAt,
              };
            } catch (err) {
              return {
                ...base,
                windows: [],
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );

        writeSnapshot({ fetchedAt: new Date().toISOString(), accounts: probed });

        const claude = probed.filter((p) => p.provider === "claude-code");
        const codex = probed.filter((p) => p.provider === "codex");
        const describe = (p: AccountUsage) => {
          const five = p.windows.find((w) => w.id === "5h")?.usedPercent;
          return `${p.label}${five == null ? "" : ` ${five}%`}`;
        };
        return {
          snapshotPath: SNAPSHOT_PATH,
          accountCount: probed.length,
          claudeCount: claude.length,
          codexCount: codex.length,
          summary:
            `claude[${claude.map(describe).join(", ") || "none"}] ` +
            `codex[${codex.map(describe).join(", ") || "none"}]`,
        };
      }}
    </Task>
  );
}
