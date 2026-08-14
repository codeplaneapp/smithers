import { useMemo } from "react";
import { useGatewayMutation, useGatewayRuns, useGatewayWorkflows } from "@smthrs/gateway-react";
import { gatewayKeys } from "@smthrs/gateway-client";
import { Badge, EmptyState, Skeleton, StatusPill } from "@smthrs/ui";
import { openSurface } from "../app/navigation";
import { statusLabel } from "../runs/statusMeta";
import { useGatewayConnectionStatus } from "../sync/useGatewayConnectionStatus";
import type { GatewayRun, GatewayWorkflow } from "./gatewayTypes";
import { toNodeStatus } from "./toNodeStatus";
import "./gateway.css";

type LaunchRunVars = {
  workflow: string;
  input: Record<string, unknown>;
};

type LaunchRunData = {
  runId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function parseWorkflows(payload: unknown): GatewayWorkflow[] {
  if (!Array.isArray(payload)) return [];
  const workflows: GatewayWorkflow[] = [];
  for (const raw of payload) {
    const record = asRecord(raw);
    const key = asString(record.key);
    const uiPath = asString(record.uiPath);
    if (key && record.hasUi === true && uiPath) {
      workflows.push({
        key,
        readableName: asString(record.readableName) || key,
        description: asString(record.description),
        uiPath,
      });
    }
  }
  return workflows;
}

function parseRuns(payload: unknown): GatewayRun[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw) => {
      const record = asRecord(raw);
      return {
        runId: asString(record.runId),
        workflowKey: asString(record.workflowKey),
        status: toNodeStatus(asString(record.status)),
        createdAtMs: asNumber(record.createdAtMs),
      };
    })
    .filter((run) => run.runId.length > 0);
}

export function GatewayWorkflowsSection() {
  const connection = useGatewayConnectionStatus();
  const workflowsState = useGatewayWorkflows({ filter: { hasUi: true } });
  const runsState = useGatewayRuns({});
  const launch = useGatewayMutation<LaunchRunVars, LaunchRunData>("launchRun", { invalidate: [gatewayKeys.runs({})] });
  const workflows = useMemo(() => parseWorkflows(workflowsState.data), [workflowsState.data]);
  const runs = useMemo(() => parseRuns(runsState.data), [runsState.data]);
  const status = connection.status;

  if (status !== "online" && status !== "connecting" && status !== "unauthorized") {
    return null;
  }

  const launchAndOpen = (workflowKey: string): void => {
    void launch.mutateSafe({ workflow: workflowKey, input: {} }).then((payload) => {
      const runId = asString(payload?.runId);
      if (runId) {
        void runsState.refetch();
        openSurface({ kind: "gatewayRun", runId, workflowKey });
      }
    });
  };

  return (
    <section className="gw-live" data-testid="gateway-live">
      <div className="gw-live-head">
        <h2 className="gw-live-title">Live workflows</h2>
        <Badge
          variant={status === "online" ? "success" : status === "unauthorized" ? "warning" : "muted"}
          data-status={status}
        >
          {status}
        </Badge>
      </div>

      {status === "unauthorized" && workflows.length === 0 ? (
        <EmptyState
          className="gw-live-empty"
          description="Sign in or provide a gateway token to access live workflows."
        />
      ) : workflowsState.error && workflows.length === 0 ? (
        <EmptyState
          className="gw-live-empty"
          title="Live workflows unavailable"
          description={workflowsState.error.message}
          role="alert"
        />
      ) : (status === "connecting" || workflowsState.loading) && workflows.length === 0 ? (
        <div className="gw-live-empty" role="status">
          <Skeleton style={{ height: 48 }} />
          <span className="sui-sr-only">Connecting to gateway...</span>
        </div>
      ) : workflows.length === 0 ? (
        <EmptyState className="gw-live-empty" description="No workflows with a custom UI on the gateway." />
      ) : (
        workflows.map((workflow) => {
          const workflowRuns = runs.filter((run) => run.workflowKey === workflow.key);
          return (
            <div className="gw-wf-card" key={workflow.key} data-testid={`gateway-wf-${workflow.key}`}>
              <div className="gw-wf-head">
                <div>
                  <div className="gw-wf-name">{workflow.readableName}</div>
                  {workflow.description ? <p className="gw-wf-desc">{workflow.description}</p> : null}
                </div>
                <button
                  className="gw-btn gw-btn-primary"
                  type="button"
                  disabled={launch.isLoading}
                  onClick={() => launchAndOpen(workflow.key)}
                >
                  {launch.isLoading ? "Launching" : "Launch"}
                </button>
              </div>

              {workflowRuns.map((run) => (
                <div className="gw-run-row" key={run.runId}>
                  <span className="gw-run-id">{run.runId}</span>
                  <StatusPill status={run.status} label={statusLabel(run.status)} />
                  <button
                    className="gw-btn"
                    type="button"
                    data-testid={`gateway-open-${run.runId}`}
                    onClick={() =>
                      openSurface({
                        kind: "gatewayRun",
                        runId: run.runId,
                        workflowKey: workflow.key,
                      })
                    }
                  >
                    Open →
                  </button>
                </div>
              ))}
            </div>
          );
        })
      )}
    </section>
  );
}
