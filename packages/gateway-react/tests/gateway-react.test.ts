import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  SmithersGatewayContext,
  SmithersGatewayProvider,
  useGatewayActions,
  useSmithersGateway,
} from "../src/index.ts";
import type { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";

function createSpyClient() {
  const calls: string[] = [];
  const client = {
    launchRun: () => calls.push("launchRun"),
    resumeRun: () => calls.push("resumeRun"),
    cancelRun: () => calls.push("cancelRun"),
    hijackRun: () => calls.push("hijackRun"),
    rewindRun: () => calls.push("rewindRun"),
    submitApproval: () => calls.push("submitApproval"),
    submitSignal: () => calls.push("submitSignal"),
    cronCreate: () => calls.push("cronCreate"),
    cronDelete: () => calls.push("cronDelete"),
    cronRun: () => calls.push("cronRun"),
  } as unknown as SmithersGatewayClient;
  return { client, calls };
}

describe("SmithersGatewayProvider", () => {
  test("provides an explicit client through context", () => {
    const { client } = createSpyClient();
    let observed: SmithersGatewayClient | null = null;

    renderToString(createElement(
      SmithersGatewayProvider,
      { client },
      createElement(SmithersGatewayContext.Consumer, {
        children: (value: SmithersGatewayClient | null) => {
          observed = value;
          return null;
        },
      }),
    ));

    expect(observed).toBe(client);
  });
});

describe("useSmithersGateway", () => {
  test("throws a clear error outside the provider", () => {
    function Probe() {
      useSmithersGateway();
      return null;
    }

    expect(() => renderToString(createElement(Probe))).toThrow(
      "useSmithersGateway() must be used inside <SmithersGatewayProvider>.",
    );
  });
});

describe("useGatewayActions", () => {
  test("exposes write helpers for the full stable gateway action surface", () => {
    const { client, calls } = createSpyClient();
    let actions: ReturnType<typeof useGatewayActions> | undefined;

    function Probe() {
      actions = useGatewayActions();
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    expect(actions).toBeDefined();
    actions?.launchRun({ workflow: "deploy" });
    actions?.resumeRun({ runId: "run-1" });
    actions?.cancelRun({ runId: "run-1" });
    actions?.hijackRun({ runId: "run-1" });
    actions?.rewindRun({ runId: "run-1", frameNo: 1, confirm: true });
    actions?.submitApproval({
      runId: "run-1",
      nodeId: "approve",
      decision: { approved: true },
    });
    actions?.submitSignal({ runId: "run-1", correlationKey: "signal-1" });
    actions?.cronCreate({ workflow: "deploy", pattern: "* * * * *" });
    actions?.cronDelete({ cronId: "cron-1" });
    actions?.cronRun({ workflow: "deploy" });

    expect(calls).toEqual([
      "launchRun",
      "resumeRun",
      "cancelRun",
      "hijackRun",
      "rewindRun",
      "submitApproval",
      "submitSignal",
      "cronCreate",
      "cronDelete",
      "cronRun",
    ]);
  });
});
