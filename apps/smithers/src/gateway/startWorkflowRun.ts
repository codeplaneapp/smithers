import { useChatStore } from "../chat/chatStore";
import type { ComposeRect } from "../chat/composeHandoffStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { openSurface } from "../app/navigation";
import { getGatewayClient } from "./gatewayClient";

type StartWorkflowRunArgs = {
  workflowKey: string;
  inputs?: Record<string, unknown>;
  morphFrom?: ComposeRect;
};

type LaunchRunResult = {
  runId?: unknown;
};

type RunEventFrame = {
  payload?: unknown;
};

function asRunId(payload: unknown): string {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as LaunchRunResult) : {};
  return typeof record.runId === "string" ? record.runId : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notificationStatusFromRunState(state: string | undefined): "running" | "done" | "failed" {
  switch (state) {
    case "failed":
    case "errored":
    case "cancelled":
    case "canceled":
      return "failed";
    case "succeeded":
    case "succeeded-with-failures":
    case "finished":
    case "completed":
    case "ok":
      return "done";
    default:
      return "running";
  }
}

function statusFromRunEvent(frame: RunEventFrame): "running" | "done" | "failed" | undefined {
  const payload = asRecord(frame.payload);
  const event = asString(payload.event);
  if (!event) return undefined;
  const innerPayload = asRecord(payload.payload);
  if (event === "run.completed") {
    return notificationStatusFromRunState(asString(innerPayload.state) ?? asString(innerPayload.status));
  }
  if (event === "run.failed" || event === "run.cancelled" || event === "run.canceled") {
    return "failed";
  }
  if (event === "run.started" || event === "run.resumed" || event === "run.paused") {
    return "running";
  }
  return undefined;
}

function streamWorkflowToast(toastId: string, runId: string): void {
  if (typeof WebSocket === "undefined") return;
  const client = getGatewayClient();
  if (typeof client.streamRunEventsResilient !== "function") return;
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const frame of client.streamRunEventsResilient(
        { runId, afterSeq: 0 },
        { signal: controller.signal },
      )) {
        const status = statusFromRunEvent(frame as RunEventFrame);
        if (!status) continue;
        useNotificationsStore.getState().update(toastId, {
          status,
          detail: status === "running" ? `run ${runId}` : `${status} · run ${runId}`,
        });
        if (status === "done" || status === "failed") {
          controller.abort();
          return;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        useNotificationsStore.getState().update(toastId, {
          detail: `stream disconnected: ${errorText(error)}`,
        });
      }
    }
  })();
}

export async function startWorkflowRun({
  workflowKey,
  inputs = {},
  morphFrom,
}: StartWorkflowRunArgs): Promise<string | undefined> {
  const title = `Workflow: ${workflowKey}`;
  useChatStore.getState().say(`On it - delegating to ${workflowKey}...`);
  const toastId = useNotificationsStore.getState().notify({
    title,
    detail: "submitting to gateway",
    kind: "workflow",
    command: "chat",
    morphFrom,
  });

  try {
    const payload = await getGatewayClient().rpcRaw("launchRun", {
      workflow: workflowKey,
      input: inputs,
    });
    const runId = asRunId(payload);
    if (!runId) {
      throw new Error("Gateway did not return a runId.");
    }

    useChatStore.getState().postCard({ kind: "gatewayRun", workflowKey, runId }, `Started ${workflowKey}.`);
    useNotificationsStore.getState().update(toastId, {
      title,
      detail: `run ${runId}`,
      runId,
      workflowKey,
    });
    streamWorkflowToast(toastId, runId);
    return runId;
  } catch (error) {
    useNotificationsStore.getState().update(toastId, {
      status: "done",
      detail: `not connected: ${errorText(error)}`,
    });
    useChatStore.getState().say(`I could not start ${workflowKey}: ${errorText(error)}`);
    return undefined;
  }
}
