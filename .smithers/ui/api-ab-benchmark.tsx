/** @jsxImportSource react */
import { useMemo } from "react";
import { createGatewayReactRoot, useGatewayRun, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Card,
  EmptyState,
  KpiStat,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SmithersUiStyles,
} from "smithers-orchestrator/ui";

const ARMS = ["effect", "jsx"] as const;
const TASKS = ["pipeline", "fanout", "reuse"] as const;
const apiAbBenchmarkStyles = ".api-ab-events { height:320px; }";

export type GatewayNode = { id: string; name?: string; status: string; output?: string };

export type TrialCell = {
  arm: string;
  taskId: string;
  trial: number;
  buildStatus: string;
  scoreStatus: string;
  verdict: "correct" | "incorrect" | "failed" | "pending";
};

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function parseOutput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string")
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Derives the arm x task x trial grid from the gateway run tree. Pure. */
export function deriveTrialCells(nodes: ReadonlyArray<GatewayNode>, trials: number): TrialCell[] {
  const cells: TrialCell[] = [];
  for (const arm of ARMS) {
    for (const taskId of TASKS) {
      for (let trial = 1; trial <= trials; trial += 1) {
        const key = `${arm}-${taskId}-${trial}`;
        const build = nodes.find((node) => node.id === `build-${key}`);
        const score = nodes.find((node) => node.id === `score-${key}`);
        const payload = parseOutput(score?.output);
        const verdict: TrialCell["verdict"] = payload?.correct
          ? "correct"
          : payload
            ? "incorrect"
            : score?.status === "failed" || build?.status === "failed"
              ? "failed"
              : "pending";
        cells.push({
          arm,
          taskId,
          trial,
          buildStatus: build?.status ?? "pending",
          scoreStatus: score?.status ?? "pending",
          verdict,
        });
      }
    }
  }
  return cells;
}

export function armSummary(
  cells: ReadonlyArray<TrialCell>,
  arm: string,
): { correct: number; done: number; total: number } {
  const armCells = cells.filter((cell) => cell.arm === arm);
  return {
    correct: armCells.filter((cell) => cell.verdict === "correct").length,
    done: armCells.filter((cell) => cell.verdict !== "pending").length,
    total: armCells.length,
  };
}

function verdictStatus(verdict: TrialCell["verdict"]): string {
  return verdict === "correct" ? "finished" : verdict === "pending" ? "pending" : "failed";
}

export function TrialGrid({ cells }: { cells: ReadonlyArray<TrialCell> }) {
  if (cells.length === 0) {
    return <EmptyState title="No trials yet" description="Start an api-ab-benchmark run to populate the grid." />;
  }
  const trials = [...new Set(cells.map((cell) => cell.trial))].sort((a, b) => a - b);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>arm / task</TableHead>
          {trials.map((trial) => (
            <TableHead key={trial}>trial {trial}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {ARMS.flatMap((arm) =>
          TASKS.map((taskId) => (
            <TableRow key={`${arm}-${taskId}`}>
              <TableCell>
                <Badge>{arm}</Badge> {taskId}
              </TableCell>
              {trials.map((trial) => {
                const cell = cells.find(
                  (entry) => entry.arm === arm && entry.taskId === taskId && entry.trial === trial,
                );
                return (
                  <TableCell key={trial}>
                    <StatusPill status={verdictStatus(cell?.verdict ?? "pending")} label={cell?.verdict ?? "pending"} />
                  </TableCell>
                );
              })}
            </TableRow>
          )),
        )}
      </TableBody>
    </Table>
  );
}

export function ApiAbBenchmarkApp({ runId = runIdFromUrl(), trials = 3 }: { runId?: string; trials?: number } = {}) {
  const run = useGatewayRun(runId);
  const tree = useGatewayRunTree(runId);
  const status =
    typeof run.data === "object" && run.data !== null && "status" in run.data ? String(run.data.status) : undefined;

  const cells = useMemo(() => deriveTrialCells(tree.nodes as unknown as GatewayNode[], trials), [tree.nodes, trials]);
  const report = useMemo(() => {
    const node = (tree.nodes as unknown as GatewayNode[]).find((entry) => entry.id === "report");
    return parseOutput(node?.output);
  }, [tree.nodes]);

  return (
    <WorkflowUiShell
      title="API A/B Benchmark"
      meta={`${runId ?? "preview"} · effect vs jsx${status ? ` · ${status}` : ""}`}
    >
      <SmithersUiStyles extra={apiAbBenchmarkStyles} />
      <Card>
        <h2>Scoreboard</h2>
        {ARMS.map((arm) => {
          const summary = armSummary(cells, arm);
          return (
            <KpiStat
              key={arm}
              label={`${arm} correct`}
              value={`${summary.correct}/${summary.total}`}
              hint={`${summary.done} scored`}
            />
          );
        })}
        {report ? <p>{String(report.verdict ?? "")}</p> : <p>Verdict appears once every trial is scored.</p>}
      </Card>
      <Card>
        <h2>Arm × task × trial</h2>
        <TrialGrid cells={cells} />
      </Card>
      <Card>
        <h2>Run tree</h2>
        <RunTree runId={runId} />
      </Card>
      <Card>
        <h2>Gateway events</h2>
        <RunEventLog runId={runId} className="api-ab-events" />
      </Card>
    </WorkflowUiShell>
  );
}

if (typeof document !== "undefined") {
  createGatewayReactRoot(<ApiAbBenchmarkApp />);
}
