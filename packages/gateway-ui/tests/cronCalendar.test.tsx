/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Real DOM before react-dom; keep Bun's native streaming fetch. Mirrors
// tests/hookComponents.test.tsx.
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SmithersCollectionsProvider, type GatewayAsyncState } from "@smithers-orchestrator/gateway-react";
import type { CronScheduleEvent } from "@smithers-orchestrator/gateway-react";
import { CronCalendar } from "../src/CronCalendar.tsx";
import { startInMemoryGateway, type InMemoryGateway, type SeedState } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
  container: HTMLElement;
  flush: (ms?: number) => Promise<void>;
  unmount: () => Promise<void>;
};

let gateway: InMemoryGateway | undefined;
const activeHarnesses: Harness[] = [];

function boot(seed: SeedState = {}): InMemoryGateway {
  gateway = startInMemoryGateway(seed);
  return gateway;
}

async function mount(gw: InMemoryGateway, element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  const harness: Harness = {
    container,
    flush: async (ms = 20) => {
      await act(async () => {
        await sleep(ms);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  activeHarnesses.push(harness);
  await act(async () => {
    root.render(
      createElement(SmithersCollectionsProvider, { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } }, element),
    );
  });
  await harness.flush();
  return harness;
}

async function waitFor(harness: Harness, assertion: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await harness.flush(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function click(el: Element | null) {
  if (!el) throw new Error("click: element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setInputValue(el: HTMLInputElement, value: string) {
  el.dispatchEvent(new Event("focusin", { bubbles: true }));
  const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  nativeSetter?.call(el, value);
  el.dispatchEvent(new Event("keyup", { bubbles: true }));
}

function changeSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.unmount().catch(() => undefined);
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

const DAILY_CRON = {
  cronId: "cron-1",
  pattern: "0 9 * * *",
  workflowPath: ".smithers/workflows/implement.tsx",
  workflow: "implement",
  enabled: true,
  createdAtMs: Date.now(),
  lastRunAtMs: null,
  nextRunAtMs: null,
  errorJson: null,
};

describe("CronCalendar (in-memory gateway)", () => {
  test("renders upcoming occurrences on the calendar and reports cron clicks", async () => {
    const gw = boot({ crons: [DAILY_CRON] });
    const selected: string[] = [];
    const harness = await mount(gw, createElement(CronCalendar, { onCronSelect: (id: string) => selected.push(id) }));
    await waitFor(
      harness,
      () => [...harness.container.querySelectorAll(".sui-cal-chip-title")].some((el) => el.textContent === "implement"),
      "occurrence chips for the seeded cron",
    );
    expect(harness.container.querySelector(".sui-cal")).not.toBeNull();
    click(harness.container.querySelector(".sui-cal-chip"));
    expect(selected).toEqual(["cron-1"]);
  });

  test("empty schedule renders the create-your-first-cron empty state", async () => {
    const gw = boot({ crons: [] });
    const harness = await mount(gw, createElement(CronCalendar, {}));
    await waitFor(harness, () => harness.container.textContent?.includes("No scheduled runs") ?? false, "empty state");
    expect(harness.container.textContent).toContain("Create your first cron");
  });

  test("quick-create registers a cron and shows its occurrences", async () => {
    const gw = boot({ crons: [], workflows: [{ key: "implement", readableName: "Implement" }] });
    const created: Array<string | undefined> = [];
    const harness = await mount(gw, createElement(CronCalendar, { onCreated: (id) => created.push(id) }));
    await waitFor(harness, () => harness.container.textContent?.includes("No scheduled runs") ?? false, "empty state");

    click([...harness.container.querySelectorAll("button")].find((el) => el.textContent === "Create cron") ?? null);
    await harness.flush();
    const form = harness.container.querySelector("form");
    expect(form).not.toBeNull();

    const inputs = [...harness.container.querySelectorAll("input")];
    setInputValue(inputs[0] as HTMLInputElement, "nightly");
    setInputValue(inputs[1] as HTMLInputElement, "0 9 * * *");
    changeSelect(harness.container.querySelector("select") as HTMLSelectElement, "implement");
    await harness.flush();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(harness, () => gw.cronsCreated.length > 0, "cronCreate POST");
    expect(gw.cronsCreated[0]).toMatchObject({ cronId: "nightly", pattern: "0 9 * * *", workflow: "implement" });
    await waitFor(
      harness,
      () => [...harness.container.querySelectorAll(".sui-cal-chip-title")].some((el) => el.textContent === "implement"),
      "occurrences of the new cron",
    );
    expect(created).toEqual(["nightly"]);
    expect(harness.container.querySelector("form")).toBeNull();
  });
});

describe("CronCalendar (hook seams)", () => {
  function seam(state: Partial<GatewayAsyncState<CronScheduleEvent[]>>): {
    useSchedule: () => GatewayAsyncState<CronScheduleEvent[]>;
    useActions: () => { cronCreate: () => Promise<Record<string, never>> };
  } {
    return {
      useSchedule: () => ({
        data: state.data,
        error: state.error,
        loading: state.loading ?? false,
        refetch: async () => {},
      }),
      useActions: () => ({ cronCreate: async () => ({}) }),
    };
  }

  test("loading renders the skeleton, not the calendar", () => {
    const { useSchedule, useActions } = seam({ loading: true });
    const html = renderToStaticMarkup(createElement(CronCalendar, { useSchedule, useActions }));
    expect(html).toContain('role="status"');
    expect(html).toContain("sui-skeleton");
    expect(html).not.toContain("sui-cal-grid");
  });

  test("error renders role=alert", () => {
    const { useSchedule, useActions } = seam({ error: new Error("schedule boom") });
    const html = renderToStaticMarkup(createElement(CronCalendar, { useSchedule, useActions }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("schedule boom");
  });
});
