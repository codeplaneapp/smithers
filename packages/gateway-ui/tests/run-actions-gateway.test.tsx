/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersCollectionsProvider } from "@smthrs/gateway-react";
import { RunsCanvas } from "../../../apps/smithers/src/runs/RunsCanvas.tsx";
import { RunsListBridge } from "../../../apps/smithers/src/runs/RunsListBridge.tsx";
import { useRunsListStore } from "../../../apps/smithers/src/runs/runsListStore.ts";
import { startInMemoryGateway, type InMemoryGateway } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let gateway: InMemoryGateway | undefined;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function flush(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

async function waitFor(assertion: () => boolean, label: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await flush(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function click(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function mount(gw: InMemoryGateway) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        SmithersCollectionsProvider,
        { mode: { kind: "local", apiBaseUrl: gw.baseUrl } },
        createElement(Fragment, null, createElement(RunsListBridge), createElement(RunsCanvas)),
      ),
    );
  });
  await waitFor(() => container?.querySelectorAll("[data-testid='runs-row']").length === 3, "gateway run rows");
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  useRunsListStore.setState(useRunsListStore.getInitialState(), true);
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

describe("gateway-backed run actions", () => {
  test("reruns failed input, hides terminal resume, and rejects a stale resume", async () => {
    gateway = startInMemoryGateway({
      runs: [
        { runId: "run-failed", workflowKey: "release", status: "failed", createdAtMs: 3 },
        { runId: "run-cancelled", workflowKey: "release", status: "cancelled", createdAtMs: 2 },
        { runId: "run-paused", workflowKey: "release", status: "paused", createdAtMs: 1 },
      ],
    });
    await mount(gateway);

    const row = (runId: string) => container!.querySelector<HTMLElement>(`[data-run-id='${runId}']`)!;
    expect(row("run-cancelled").querySelector("[data-testid='runs-resume']")).toBeNull();

    await act(async () => click(row("run-failed").querySelector("[data-testid='runs-retry']")));
    await act(async () => click(row("run-failed").querySelector("[data-testid='runs-confirm-retry']")));
    await waitFor(
      () => gateway!.runActions.some((entry) => entry.action === "retry" && entry.runId === "run-failed"),
      "gateway rerun request",
    );
    await waitFor(
      () => row("run-failed").querySelector("[role='status']")?.textContent?.includes("run-failed-rerun-1") === true,
      "rerun success feedback",
    );
    expect(gateway.state.runs.some((run) => run.runId === "run-failed-rerun-1" && run.status === "running")).toBe(true);

    const serverRow = gateway.state.runs.find((run) => run.runId === "run-paused")!;
    serverRow.status = "failed";
    await act(async () => click(row("run-paused").querySelector("[data-testid='runs-resume']")));
    await waitFor(
      () => row("run-paused").querySelector("[role='alert']")?.textContent?.includes("terminal state") === true,
      "stale resume error",
    );
    expect(gateway.runActions.some((entry) => entry.action === "resume" && entry.runId === "run-paused")).toBe(true);
    expect(row("run-paused").querySelector<HTMLButtonElement>("[data-testid='runs-resume']")?.disabled).toBe(false);
  });
});
