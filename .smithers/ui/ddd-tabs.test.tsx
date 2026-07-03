/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import "../../packages/gateway-react/tests/happy-dom-ws-guard.ts";

if (typeof document === "undefined" || !document?.createElement) {
  GlobalRegistrator.register();
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createSmithers, Gateway } from "smithers-orchestrator";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "smithers-orchestrator/gateway-react";
import { z } from "zod/v4";
import type { Feature, TicketRow } from "./ddd-shared";

const { docsContent } = await import("./ddd-docsContent.generated");
const { ticketsBacklog } = await import("./ddd-ticketsBacklog.generated");
const { FeatureDetail, MarkdownEditor, MarkdownPreview, SpecFileTree, buildChatLines, changedFilesFromMetaTicket, features, formatCount, formatTicketKind, loadSpecDrafts, reconcileDraftsAfterRun, saveSpecDrafts, updatedDocPathsFromSpec, uploadAsset, useDialogFocusTrap } = await import("./ddd-shared");
const { FeaturesTab } = await import("./ddd-FeaturesTab");
const { SpecsTab } = await import("./ddd-SpecsTab");
const { AuditTab } = await import("./ddd-AuditTab");
const { TicketsTab } = await import("./ddd-TicketsTab");
const { LiveTab } = await import("./ddd-LiveTab");
const { NewEntryMenu, StartPane } = await import("./ddd-StartPane");
const { App, builderWorkflowName, createWorkflowPromptForApp, shouldPollKickoffNode } = await import("./docs-driven-development");
type AppProps = Parameters<typeof App>[0];
const {
  Tutorial,
  markTutorialDone,
  shouldShowTutorial,
  tutorialDisabledByUrl,
  tutorialDone,
  tutorialStorageAvailable,
} = await import("./ddd-Tutorial");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Harness = {
  container: HTMLDivElement;
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

const harnesses: Harness[] = [];
const servers: Server[] = [];
const gateways: Gateway[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (gateways.length > 0) {
    try {
      await gateways.pop()!.close();
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop()!);
  document.body.innerHTML = "";
  window.localStorage.clear();
  setWindowUrl("/workflows/docs-driven-development");
});

function removeTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}

function setWindowUrl(pathname: string) {
  const url = new URL(pathname, "http://localhost");
  const locationValue = {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    assign: () => undefined,
    replace: () => undefined,
    reload: () => undefined,
    toString: () => url.href,
  };
  Object.defineProperty(window, "location", { configurable: true, value: locationValue });
  Object.defineProperty(globalThis, "location", { configurable: true, value: locationValue });
  Object.defineProperty(window, "navigator", { configurable: true, value: { userAgent: "happy-dom" } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "happy-dom" } });
}

async function mount(element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  let unmounted = false;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  const harness = {
    container,
    render: async (next: ReactElement) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
      container.remove();
    },
  };
  harnesses.push(harness);
  return harness;
}

function text(container: Element | Document = document) {
  return container.textContent ?? "";
}

function setInputValue(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const previous = input.value;
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  (input as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(previous);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const previous = select.value;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  (select as HTMLSelectElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(previous);
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function buttonByText(container: Element, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => text(candidate).includes(label));
  if (!button) throw new Error(`missing button: ${label}`);
  return button as HTMLButtonElement;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function localJsonServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; server: Server }> {
  const server = createHttpServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,x-filename");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, server };
}

function makeStaticWorkflow(name: string, dbPath: string, delayMs = 0) {
  const row = z.object({
    summary: z.string().default(""),
    status: z.string().default("partial"),
    source: z.string().default(""),
    docPath: z.string().default(""),
    changedFiles: z.array(z.any()).default([]),
    beforeMarkdown: z.string().default(""),
    afterMarkdown: z.string().default(""),
    updatedFiles: z.array(z.string()).default([]),
    featureIds: z.array(z.string()).default([]),
    broken: z.array(z.string()).default([]),
    partial: z.array(z.string()).default([]),
    missingE2E: z.array(z.string()).default([]),
    missingDocs: z.array(z.string()).default([]),
    selected: z.array(z.any()).default([]),
    tickets: z.array(z.any()).default([]),
    approved: z.boolean().default(true),
  }).passthrough();
  const { smithers, Workflow: W, Task: T, outputs } = createSmithers({
    bootstrap: row,
    metaTicket: row,
    audit: row,
    spec: row,
    triage: row,
    materializedTickets: row,
    summary: row,
    done: row,
  }, { dbPath });

  if (name !== "docs-driven-development") {
    return smithers(() => (
      <W name={name}>
        <T id="done" output={outputs.done}>
          {async () => {
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return { summary: `${name} done`, status: "done" };
          }}
        </T>
      </W>
    ));
  }

  return smithers((ctx) => (
    <W name="docs-driven-development">
      <T id="bootstrap" output={outputs.bootstrap}>
        {{ summary: "bootstrap ok", status: "done" }}
      </T>
      <T id="metaTicket" output={outputs.metaTicket}>
        {async () => {
          const ticket = (ctx.input as any).metaTicket ?? {};
          return {
            summary: "meta ok",
            status: "done",
            source: ticket.source ?? "",
            docPath: ticket.docPath ?? "",
            changedFiles: ticket.changedFiles ?? [],
            beforeMarkdown: ticket.beforeMarkdown ?? "",
            afterMarkdown: ticket.afterMarkdown ?? "",
          };
        }}
      </T>
      <T id="spec-update" output={outputs.spec}>
        {{ summary: "spec ok", status: "ready", updatedFiles: ["overview.md"] }}
      </T>
      <T id="audit" output={outputs.audit} dependsOn={["metaTicket"]}>
        {{ summary: "audit ok", status: "done", featureIds: ["docs-driven-development"], broken: [], partial: [], missingE2E: [], missingDocs: [] }}
      </T>
      <T id="triage" output={outputs.triage} dependsOn={["spec-update"]}>
        {{
          summary: "triage ok",
          selected: [{
            slot: 1,
            featureId: "docs-driven-development",
            title: "Top-level App test",
            agent: "codex",
            taskType: "e2e",
            reason: "Exercise App launch state.",
          }],
        }}
      </T>
      <T id="materialize-tickets" output={outputs.materializedTickets} dependsOn={["triage"]}>
        {{
          summary: "materialized",
          tickets: [{
            path: "docs-driven-development--app-run--01-docs-driven-development",
            kind: "ticket",
            status: "todo",
            content: "# App materialized ticket",
            featureId: "docs-driven-development",
            featureTitle: "Docs driven development",
            updatedAtMs: 1,
          }],
        }}
      </T>
      <T id="round-summary" output={outputs.summary} dependsOn={["materialize-tickets"]}>
        {async () => {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { summary: "round ok", status: "partial" };
        }}
      </T>
    </W>
  ));
}

async function mountAppWithGateway(
  pathname = "/workflows/docs-driven-development",
  appProps: AppProps = {},
): Promise<Harness & { gateway: Gateway; base: string }> {
  const root = mkdtempSync(join(tmpdir(), "ddd-app-unit-"));
  tempDirs.push(root);
  const gateway = new Gateway({ heartbeatMs: 50 });
  gateways.push(gateway);
  gateway.register("docs-driven-development", makeStaticWorkflow("docs-driven-development", join(root, "ddd.db"), 50) as Parameters<typeof gateway.register>[1], {
    ui: { entry: "docs-driven-development.tsx", title: "Docs Driven Development" },
  });
  gateway.register("create-workflow", makeStaticWorkflow("create-workflow", join(root, "create.db")) as Parameters<typeof gateway.register>[1]);
  gateway.register("ddd-generate-docs", makeStaticWorkflow("ddd-generate-docs", join(root, "generate.db")) as Parameters<typeof gateway.register>[1]);
  gateway.register("ddd-bug-scan", makeStaticWorkflow("ddd-bug-scan", join(root, "bug.db")) as Parameters<typeof gateway.register>[1]);
  gateway.register("other-workflow", makeStaticWorkflow("other-workflow", join(root, "other.db")) as Parameters<typeof gateway.register>[1]);
  if (pathname.includes("url-run")) {
    await gateway.startRun("docs-driven-development", {}, { triggeredBy: "unit", scopes: ["*"], role: "operator", tokenId: null } as any, "url-run", { resume: false });
    await gateway.inflightRuns.get("url-run");
  }
  if (pathname.includes("generate-run")) {
    await gateway.startRun("ddd-generate-docs", {}, { triggeredBy: "unit", scopes: ["*"], role: "operator", tokenId: null } as any, "generate-run", { resume: false });
    await gateway.inflightRuns.get("generate-run");
  }
  if (pathname.includes("bug-run")) {
    await gateway.startRun("ddd-bug-scan", {}, { triggeredBy: "unit", scopes: ["*"], role: "operator", tokenId: null } as any, "bug-run", { resume: false });
    await gateway.inflightRuns.get("bug-run");
  }
  if (pathname.includes("other-run")) {
    await gateway.startRun("other-workflow", {}, { triggeredBy: "unit", scopes: ["*"], role: "operator", tokenId: null } as any, "other-run", { resume: false });
    await gateway.inflightRuns.get("other-run");
  }
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  const address = (gateway as unknown as { server: Server }).server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  setWindowUrl(pathname);
  const client = new SmithersGatewayClient({
    baseUrl: base,
    fetch: Bun.fetch as typeof fetch,
    WebSocket: globalThis.WebSocket,
  });
  // SmithersGatewayProvider now builds and provides the collection layer itself
  // (from the client's base URL), mirroring the production mount
  // `createGatewayReactRoot(<App />)`, so no separate sync provider is needed.
  const harness = await mount(
    <SmithersGatewayProvider client={client}>
      <App {...appProps} />
    </SmithersGatewayProvider>,
  );
  return { ...harness, gateway, base };
}

describe("DDD tabs and components", () => {
  test("App mounts cleanly with no URL runId", async () => {
    const app = await mountAppWithGateway("/workflows/docs-driven-development?tutorial=off");
    await waitFor(() => expect(app.container.querySelector('[data-testid="docs-driven-development-ui"]')).toBeTruthy());
    expect(text(app.container.querySelector('[data-testid="ddd-run-id"]') as HTMLElement)).toContain("workflow");
    expect(app.container.querySelector('[data-testid="ddd-features-tab"]')).toBeTruthy();
    await act(async () => (app.container.querySelector('[data-testid="ddd-open-start"]') as HTMLButtonElement).click());
    expect(app.container.querySelector('[data-testid="ddd-new-menu"]')).toBeTruthy();
    expect(app.container.querySelector('[data-testid="ddd-start-pane"]')).toBeFalsy();
    expect(app.container.querySelector('[data-testid="ddd-features-tab"]')).toBeTruthy();
  }, 60_000);

  test("App mounted with stub generated spec starts in the non-dismissible Start pane and keeps launch wiring", async () => {
    const stubDocs = [{
      path: "overview.md",
      title: "Overview",
      level: "product" as const,
      content: "# Overview\n\nSeeded starter doc.\n",
    }];
    const app = await mountAppWithGateway(
      "/workflows/docs-driven-development?tutorial=off",
      { specFeatures: [], specDocs: stubDocs, ticketsBacklogData: [] },
    );

    await waitFor(() => expect(app.container.querySelector('[data-testid="docs-driven-development-ui"]')).toBeTruthy());
    expect(app.container.querySelector('[data-testid="ddd-start-pane"]')).toBeTruthy();
    expect(app.container.querySelector('[data-testid="ddd-tutorial"]')).toBeFalsy();
    expect(app.container.querySelector('[data-testid="ddd-tabbar"]')?.hasAttribute("hidden")).toBe(true);
    expect(app.container.querySelector('[data-testid="ddd-start-pane"] button[aria-label="Close"]')).toBeFalsy();

    const createButton = app.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    await act(async () => setInputValue(app.container.querySelector('[data-testid="ddd-start-description"]') as HTMLTextAreaElement, "Build a stub-mode app"));
    expect(createButton.disabled).toBe(false);
    await act(async () => createButton.click());
    await waitFor(() => expect(text(app.container.querySelector('[data-testid="ddd-start-launched"]') as HTMLElement)).toContain("create-workflow"), 10_000);

    await act(async () => (app.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).click());
    await waitFor(() => expect(text(app.container.querySelector('[data-testid="ddd-start-generate-run"]') as HTMLElement)).toContain("ddd-generate-docs"), 10_000);
    expect(app.container.querySelector('[data-testid="ddd-start-pane"]')).toBeTruthy();
    expect(app.container.querySelector('[data-testid="ddd-tabbar"]')?.hasAttribute("hidden")).toBe(true);
  }, 60_000);

  test("App mounts with real gateway-react state, navigates tabs, handles drafts, and suppresses duplicate launches", async () => {
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const app = await mountAppWithGateway("/workflows/docs-driven-development?runId=url-run&tutorial=off");

    await waitFor(() => expect(app.container.querySelector('[data-testid="docs-driven-development-ui"]')).toBeTruthy());
    expect(text(app.container.querySelector('[data-testid="ddd-run-id"]') as HTMLElement)).toContain("url-run");
    expect(app.container.querySelector('[data-testid="ddd-start-pane"]')).toBeFalsy();
    expect(app.container.querySelector('[data-testid="ddd-features-tab"]')).toBeTruthy();

    const featuresTab = app.container.querySelector('[data-testid="ddd-tab-features"]') as HTMLButtonElement;
    await act(async () => featuresTab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    await waitFor(() => expect(app.container.querySelector('[data-testid="ddd-tab-tickets"]')?.getAttribute("aria-selected")).toBe("true"));
    await act(async () => (app.container.querySelector('[data-testid="ddd-tab-tickets"]') as HTMLButtonElement)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    await waitFor(() => expect(app.container.querySelector('[data-testid="ddd-tab-features"]')?.getAttribute("aria-selected")).toBe("true"));
    await act(async () => (app.container.querySelector('[data-testid="ddd-tab-features"]') as HTMLButtonElement)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await waitFor(() => expect(app.container.querySelector('[data-testid="ddd-tab-specs"]')?.getAttribute("aria-selected")).toBe("true"));

    await waitFor(() => expect(app.container.querySelector('[data-testid="ddd-editor"]')).toBeTruthy());
    const beforeUnloadAdds: string[] = [];
    const beforeUnloadRemoves: string[] = [];
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "beforeunload") beforeUnloadAdds.push(type);
      return originalAdd(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "beforeunload") beforeUnloadRemoves.push(type);
      return originalRemove(type, listener, options);
    }) as typeof window.removeEventListener;

    try {
      const editor = app.container.querySelector('[data-testid="ddd-editor"]') as HTMLTextAreaElement;
      await act(async () => setInputValue(editor, `${productDoc.content}\nApp draft line\n`));
      await waitFor(() => expect((app.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(false));
      expect(beforeUnloadAdds).toEqual(["beforeunload"]);
      expect(loadSpecDrafts(docsContent)[productDoc.path]).toContain("App draft line");

      await act(async () => setInputValue(editor, productDoc.content));
      await waitFor(() => expect((app.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true));
      expect(loadSpecDrafts(docsContent)[productDoc.path]).toBeUndefined();
      expect(beforeUnloadRemoves).toEqual(["beforeunload"]);

      await act(async () => setInputValue(editor, `${productDoc.content}\nDispatch once\n`));
      const beforeRuns = await (app.gateway as any).routeRequest({
        connectionId: "app-unit-before",
        transport: "test",
        authenticated: true,
        role: "operator",
        scopes: ["*"],
        userId: "app-unit",
        tokenId: null,
        subscribedRuns: new Set<string>(),
      }, { type: "req", id: "before", method: "runs.list", params: { limit: 100 } });
      const beforeCount = (beforeRuns.payload as Array<Record<string, unknown>>).filter((run) => run.workflowKey === "docs-driven-development").length;
      const dispatch = app.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement;
      await act(async () => {
        dispatch.click();
        dispatch.click();
      });
      await waitFor(() => expect(app.container.querySelector('[data-testid="ddd-tab-live"]')?.getAttribute("aria-selected")).toBe("true"), 10_000);
      let docsRuns: Array<Record<string, unknown>> = [];
      await waitFor(async () => {
        const afterRuns = await (app.gateway as any).routeRequest({
          connectionId: "app-unit-after",
          transport: "test",
          authenticated: true,
          role: "operator",
          scopes: ["*"],
          userId: "app-unit",
          tokenId: null,
          subscribedRuns: new Set<string>(),
        }, { type: "req", id: "after", method: "runs.list", params: { limit: 100 } });
        docsRuns = (afterRuns.payload as Array<Record<string, unknown>>).filter((run) => run.workflowKey === "docs-driven-development");
        expect(docsRuns.length).toBe(beforeCount + 1);
      }, 10_000);
      const launchedRunId = String(docsRuns.find((run) => run.runId !== "url-run")?.runId ?? "");
      await waitFor(() => {
        const runTitles = [...app.container.querySelectorAll('[data-testid="ddd-live-tab"] .rid')]
          .map((node) => node.getAttribute("title"));
        expect(runTitles).toContain(launchedRunId);
      }, 10_000);
      await waitFor(() => expect(loadSpecDrafts(docsContent)[productDoc.path]).toBeUndefined(), 30_000);
      await act(async () => (app.container.querySelector('[data-testid="ddd-tab-specs"]') as HTMLButtonElement).click());
      await waitFor(() => {
        expect(text(app.container.querySelector('[data-testid="ddd-draft-run-state"]') as HTMLElement)).toContain("Applied");
        expect((app.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true);
      });
      expect(beforeUnloadRemoves.length).toBeGreaterThanOrEqual(2);
    } finally {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    }
  }, 120_000);

  test("App includes the active non-DDD URL run and falls back to sibling DDD workflow source", async () => {
    const other = await mountAppWithGateway("/workflows/other-workflow?runId=other-run&tutorial=off");
    await act(async () => (other.container.querySelector('[data-testid="ddd-tab-live"]') as HTMLButtonElement).click());
    await waitFor(() => expect(text(other.container.querySelector('[data-testid="ddd-live-tab"]') as HTMLElement)).toContain("other-run"));

    await other.unmount();
    const generate = await mountAppWithGateway("/workflows/ddd-generate-docs?runId=generate-run&tutorial=off");
    await act(async () => (generate.container.querySelector('[data-testid="ddd-tab-live"]') as HTMLButtonElement).click());
    await waitFor(() => expect(text(generate.container.querySelector('[data-testid="ddd-workflow-source"]') as HTMLElement)).toContain("DDD Generate Docs"));

    await generate.unmount();
    const bug = await mountAppWithGateway("/workflows/ddd-bug-scan?runId=bug-run&tutorial=off");
    await act(async () => (bug.container.querySelector('[data-testid="ddd-tab-live"]') as HTMLButtonElement).click());
    await waitFor(() => expect(text(bug.container.querySelector('[data-testid="ddd-workflow-source"]') as HTMLElement)).toContain("DDD Bug Scan"));
  }, 60_000);

  test("FeaturesTab renders real feature tiers, counts, and opens a feature", async () => {
    const opened: Feature[] = [];
    const harness = await mount(<FeaturesTab onOpenFeature={(feature) => opened.push(feature)} />);

    expect(harness.container.querySelector('[data-testid="ddd-features-tab"]')).toBeTruthy();
    expect(text(harness.container)).toContain(`${features.length} features`);
    expect(harness.container.querySelector('[data-testid="ddd-tier-feature"]')).toBeTruthy();
    expect(harness.container.querySelectorAll('[data-testid="ddd-feature-card"]').length).toBe(features.length);

    const first = harness.container.querySelector('[data-testid="ddd-feature-card"]') as HTMLButtonElement;
    await act(async () => first.click());
    expect(opened[0]?.id).toBe(features[0]?.id);
  });

  test("shared count and kind labels are polished for singular cards and ticket pills", () => {
    expect(formatCount(1, "capability", "capabilities")).toBe("1 capability");
    expect(formatCount(2, "capability", "capabilities")).toBe("2 capabilities");
    expect(formatTicketKind("e2e")).toBe("E2E");
    expect(formatTicketKind("fix")).toBe("Fix");
  });

  test("FeaturesTab filters by search, status, tier, clears filters, reports no matches, and preserves group order", async () => {
    const target = features.find((feature) => {
      const token = feature.title;
      return features.filter((item) => JSON.stringify(item).toLowerCase().includes(token.toLowerCase())).length === 1;
    }) ?? features[0]!;
    const harness = await mount(<FeaturesTab onOpenFeature={() => undefined} />);
    const search = harness.container.querySelector('input[type="search"]') as HTMLInputElement;
    const [statusSelect, tierSelect] = [...harness.container.querySelectorAll("select")] as HTMLSelectElement[];

    const expectedGroups: string[] = [];
    for (const tier of ["feature", "platform", "reference"]) {
      const tierGroups: string[] = [];
      for (const feature of features.filter((item) => (item.tier ?? "feature") === tier)) {
        const group = feature.group ?? "General";
        if (!tierGroups.includes(group)) tierGroups.push(group);
      }
      expectedGroups.push(...tierGroups);
    }
    expect([...harness.container.querySelectorAll(".group-title")].map((node) => text(node))).toEqual(expectedGroups);

    await act(async () => setInputValue(search, target.title));
    expect(harness.container.querySelectorAll('[data-testid="ddd-feature-card"]').length).toBe(1);
    expect(text(harness.container)).toContain(target.title);

    await act(async () => setSelectValue(statusSelect!, target.status));
    expect([...harness.container.querySelectorAll('[data-testid="ddd-feature-card"]')]
      .every((card) => text(card).includes(target.title))).toBe(true);

    await act(async () => setSelectValue(tierSelect!, target.tier ?? "feature"));
    expect(text(harness.container)).toContain(target.title);
    expect(buttonByText(harness.container, "Clear")).toBeTruthy();

    await act(async () => setInputValue(search, "definitely-no-such-ddd-feature"));
    expect(harness.container.querySelectorAll('[data-testid="ddd-feature-card"]').length).toBe(0);
    expect(text(harness.container)).toContain("No matching features");

    await act(async () => buttonByText(harness.container, "Clear").click());
    expect((search as HTMLInputElement).value).toBe("");
    expect(statusSelect!.value).toBe("all");
    expect(tierSelect!.value).toBe("all");
    expect(harness.container.querySelectorAll('[data-testid="ddd-feature-card"]').length).toBe(features.length);
  });

  test("FeatureDetail renders capabilities, endpoints, links, evidence, gaps, close, and doc-link callbacks", async () => {
    const openedDocs: string[] = [];
    let closed = 0;
    const feature: Feature = {
      id: "ddd-test-feature",
      title: "DDD Test Feature",
      summary: "Detailed feature summary.",
      status: "partial",
      priority: "p0",
      owner: "qa",
      group: "Run & observe",
      userValue: "Inspect a real DDD surface.",
      capabilities: [{ title: "Inspect", detail: "Shows details.", status: "fixed" }],
      endpoints: [{ method: "POST", path: "/runs", doc: "reference/api.md#runs", note: "launch" }],
      links: [{ label: "Overview", href: "overview.md" }],
      tests: ["bun test ui/ddd-tabs.test.tsx"],
      observability: ["run events"],
      debug: ["smithers inspect"],
      architecture: ["gateway"],
      evidence: ["screenshot"],
      changes: ["change note"],
      diffHints: ["packages/server/src/index.ts"],
      missing: ["browser proof"],
    };

    const harness = await mount(
      <FeatureDetail
        feature={feature}
        note="Audit note for ddd-test-feature"
        assetUrl={(path?: string) => path}
        onClose={() => { closed += 1; }}
        onOpenDoc={(href) => openedDocs.push(href)}
      />,
    );

    const body = text(harness.container);
    expect(body).toContain("DDD Test Feature");
    expect(body).toContain("Capabilities");
    expect(body).toContain("POST /runs");
    expect(body).toContain("Related docs");
    expect(body).toContain("Evidence");
    expect(body).toContain("Open Gaps");
    expect(body).toContain("Audit note for ddd-test-feature");

    const docButton = [...harness.container.querySelectorAll("button.doc-link")]
      .find((button) => text(button).includes("docs")) as HTMLButtonElement;
    await act(async () => docButton.click());
    expect(openedDocs).toContain("reference/api.md#runs");

    const close = harness.container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => close.click());
    expect(closed).toBe(1);

    await harness.render(
      <FeatureDetail
        feature={feature}
        assetUrl={(path?: string) => path}
        onClose={() => { closed += 1; }}
      />,
    );
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(2);
  });

  test("FeatureDetail traps focus, labels the dialog, and restores the opener", async () => {
    const feature: Feature = {
      id: "focus-feature",
      title: "Focus Feature",
      summary: "Focus summary.",
      status: "partial",
      priority: "p0",
      owner: "qa",
      links: [{ label: "Overview", href: "overview.md" }],
    };
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="focus-opener" onClick={() => setOpen(true)}>
            Open detail
          </button>
          <button type="button" data-testid="focus-background">
            Background action
          </button>
          {open ? (
            <FeatureDetail
              feature={feature}
              assetUrl={(path?: string) => path}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    const harness = await mount(<FocusHarness />);
    const opener = harness.container.querySelector('[data-testid="focus-opener"]') as HTMLButtonElement;
    opener.focus();
    await act(async () => opener.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = harness.container.querySelector('[data-testid="ddd-feature-detail"]') as HTMLElement;
    const close = dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    const docLink = dialog.querySelector("button.doc-link") as HTMLButtonElement;
    expect(dialog.getAttribute("aria-labelledby")).toBe("ddd-feature-detail-title");
    expect(document.activeElement).toBe(close);

    await act(async () => docLink.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(close);

    const background = harness.container.querySelector('[data-testid="focus-background"]') as HTMLButtonElement;
    background.focus();
    await act(async () => background.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(document.activeElement).toBe(close);

    await act(async () => close.click());
    expect(harness.container.querySelector('[data-testid="ddd-feature-detail"]')).toBeFalsy();
    expect(document.activeElement).toBe(opener);
  });

  test("stacked dialog focus traps only let the top dialog handle focus, Escape, and cleanup", async () => {
    const listenerAdds: string[] = [];
    const listenerRemoves: string[] = [];
    const originalAdd = document.addEventListener.bind(document);
    const originalRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "keydown" || type === "focusin") listenerAdds.push(type);
      return originalAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "keydown" || type === "focusin") listenerRemoves.push(type);
      return originalRemove(type, listener, options);
    }) as typeof document.removeEventListener;

    function Dialog(props: { id: string; onClose: () => void; noFocusable?: boolean; children?: ReactElement }) {
      const modalRef = useState(() => ({ current: null as HTMLElement | null }))[0];
      const firstRef = useState(() => ({ current: null as HTMLButtonElement | null }))[0];
      useDialogFocusTrap({ containerRef: modalRef, initialFocusRef: props.noFocusable ? undefined : firstRef, onClose: props.onClose });
      return (
        <section ref={(node) => { modalRef.current = node; }} data-testid={props.id} role="dialog" tabIndex={-1}>
          {props.noFocusable ? null : <button ref={(node) => { firstRef.current = node; }} type="button" data-testid={`${props.id}-close`} onClick={props.onClose}>Close {props.id}</button>}
          {props.noFocusable ? null : <button type="button" data-testid={`${props.id}-last`}>Last {props.id}</button>}
          {props.children}
        </section>
      );
    }

    function StackHarness() {
      const [lower, setLower] = useState(false);
      const [top, setTop] = useState(false);
      const [empty, setEmpty] = useState(false);
      return (
        <>
          <button type="button" data-testid="stack-opener" onClick={() => setLower(true)}>Open lower</button>
          <button type="button" data-testid="stack-background">Background</button>
          {lower ? (
            <Dialog id="lower-dialog" onClose={() => setLower(false)}>
              <button type="button" data-testid="open-top" onClick={() => setTop(true)}>Open top</button>
            </Dialog>
          ) : null}
          {top ? (
            <Dialog id="top-dialog" onClose={() => setTop(false)}>
              <button type="button" data-testid="open-empty" onClick={() => setEmpty(true)}>Open empty</button>
            </Dialog>
          ) : null}
          {empty ? <Dialog id="empty-dialog" noFocusable onClose={() => setEmpty(false)} /> : null}
        </>
      );
    }

    try {
      const harness = await mount(<StackHarness />);
      const opener = harness.container.querySelector('[data-testid="stack-opener"]') as HTMLButtonElement;
      opener.focus();
      await act(async () => opener.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const lowerClose = harness.container.querySelector('[data-testid="lower-dialog-close"]') as HTMLButtonElement;
      const lowerLast = harness.container.querySelector('[data-testid="lower-dialog-last"]') as HTMLButtonElement;
      expect(document.activeElement).toBe(lowerClose);

      const openTop = harness.container.querySelector('[data-testid="open-top"]') as HTMLButtonElement;
      openTop.focus();
      await act(async () => openTop.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const topClose = harness.container.querySelector('[data-testid="top-dialog-close"]') as HTMLButtonElement;
      const topLast = harness.container.querySelector('[data-testid="top-dialog-last"]') as HTMLButtonElement;
      expect(document.activeElement).toBe(topClose);

      await act(async () => topLast.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
      expect(document.activeElement).toBe(topClose);
      await act(async () => topClose.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
      expect(document.activeElement).toBe(harness.container.querySelector('[data-testid="open-empty"]'));

      const background = harness.container.querySelector('[data-testid="stack-background"]') as HTMLButtonElement;
      background.focus();
      await act(async () => background.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      expect(document.activeElement).toBe(topClose);
      expect(document.activeElement).not.toBe(lowerClose);

      const openEmpty = harness.container.querySelector('[data-testid="open-empty"]') as HTMLButtonElement;
      openEmpty.focus();
      await act(async () => openEmpty.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const emptyDialog = harness.container.querySelector('[data-testid="empty-dialog"]') as HTMLElement;
      expect(document.activeElement).toBe(emptyDialog);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(harness.container.querySelector('[data-testid="empty-dialog"]')).toBeFalsy();
      expect(harness.container.querySelector('[data-testid="top-dialog"]')?.contains(document.activeElement)).toBe(true);

      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(harness.container.querySelector('[data-testid="top-dialog"]')).toBeFalsy();
      expect(harness.container.querySelector('[data-testid="lower-dialog"]')).toBeTruthy();
      expect(harness.container.querySelector('[data-testid="lower-dialog"]')?.contains(document.activeElement)).toBe(true);

      await act(async () => lowerLast.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
      expect(document.activeElement).toBe(lowerClose);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(harness.container.querySelector('[data-testid="lower-dialog"]')).toBeFalsy();
      expect(document.activeElement).toBe(opener);

      await harness.unmount();
      expect(listenerRemoves.filter((type) => type === "keydown").length).toBe(listenerAdds.filter((type) => type === "keydown").length);
      expect(listenerRemoves.filter((type) => type === "focusin").length).toBe(listenerAdds.filter((type) => type === "focusin").length);
    } finally {
      document.addEventListener = originalAdd;
      document.removeEventListener = originalRemove;
    }
  });

  test("SpecFileTree groups nested directories and reports selected files", async () => {
    const selected: string[] = [];
    const harness = await mount(
      <SpecFileTree
        files={[{ path: "overview.md" }, { path: "features/cli.md" }, { path: "reference/api.md" }]}
        selectedPath="features/cli.md"
        changedPaths={["overview.md"]}
        onSelect={(path) => selected.push(path)}
      />,
    );

    expect(text(harness.container)).toContain("features");
    expect(text(harness.container)).toContain("reference");
    const active = [...harness.container.querySelectorAll('[data-testid="ddd-tree-file"]')]
      .find((button) => text(button).includes("cli.md")) as HTMLButtonElement;
    expect(active.className).toContain("is-active");

    const overview = [...harness.container.querySelectorAll('[data-testid="ddd-tree-file"]')]
      .find((button) => text(button).includes("overview.md")) as HTMLButtonElement;
    expect(overview.className).toContain("is-dirty");
    expect(overview.querySelector(".tree-dirty")).toBeTruthy();
    await act(async () => overview.click());
    expect(selected).toEqual(["overview.md"]);
  });

  test("SpecsTab covers empty docs plus dirty dispatch disabled/enabled states", async () => {
    const dispatched: string[][] = [];
    const empty = await mount(
      <SpecsTab
        docs={[]}
        drafts={{}}
        selectedPath=""
        assetBase={undefined}
        changedPaths={[]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDispatch={(paths) => dispatched.push(paths)}
      />,
    );

    expect(text(empty.container)).toContain("No narrative docs found");
    expect((empty.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true);
    expect((empty.container.querySelector('[data-testid="ddd-create-meta-ticket"]') as HTMLButtonElement).disabled).toBe(true);

    // Dispatch is a PRODUCT-doc affordance: technical docs are derived and
    // read-only, so the dirty/dispatch cycle is exercised on a product doc.
    const firstDoc = docsContent.find((doc) => doc.level === "product")!;
    await empty.render(
      <SpecsTab
        docs={[firstDoc]}
        drafts={{ [firstDoc.path]: `${firstDoc.content}\nDirty line\n` }}
        selectedPath={firstDoc.path}
        assetBase={undefined}
        changedPaths={[firstDoc.path]}
        launchedRunId="run-1"
        launchError={null}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDispatch={(paths) => dispatched.push(paths)}
      />,
    );

    const dispatchFile = empty.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement;
    const dispatchAll = empty.container.querySelector('[data-testid="ddd-create-meta-ticket"]') as HTMLButtonElement;
    expect(dispatchFile.disabled).toBe(false);
    expect(dispatchAll.disabled).toBe(false);
    expect(text(empty.container)).toContain("Run run-1 dispatched from the docs editor.");

    await act(async () => dispatchFile.click());
    await act(async () => dispatchAll.click());
    expect(dispatched).toEqual([[firstDoc.path], [firstDoc.path]]);
  });

  test("SpecsTab disables dispatch while launching and offers recovered-draft discard controls", async () => {
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const dirty = `${productDoc.content}\nRecovered local edit\n`;
    const discarded: string[][] = [];
    const harness = await mount(
      <SpecsTab
        docs={[productDoc]}
        drafts={{ [productDoc.path]: dirty }}
        selectedPath={productDoc.path}
        assetBase={undefined}
        changedPaths={[productDoc.path]}
        launchPending
        launchedRunId={null}
        launchError={null}
        recoveredPaths={[productDoc.path]}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDiscardDrafts={(paths) => discarded.push(paths)}
        onDispatch={() => { throw new Error("dispatch should be disabled while launching"); }}
      />,
    );

    expect((harness.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.container.querySelector('[data-testid="ddd-create-meta-ticket"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text(harness.container)).toContain("Dispatching");
    expect(text(harness.container)).toContain("Recovered");
    expect(text(harness.container)).toContain("restored from this browser");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-discard-file"]') as HTMLButtonElement).click());
    await act(async () => (harness.container.querySelector('[data-testid="ddd-discard-all"]') as HTMLButtonElement).click());
    await act(async () => buttonByText(harness.container, "Discard recovered").click());
    expect(discarded).toEqual([[productDoc.path], [productDoc.path], [productDoc.path]]);

    await harness.render(
      <SpecsTab
        docs={[productDoc]}
        drafts={{ [productDoc.path]: dirty }}
        selectedPath={productDoc.path}
        assetBase={undefined}
        changedPaths={[productDoc.path]}
        launchedRunId="run-dispatched"
        launchError={null}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDiscardDrafts={(paths) => discarded.push(paths)}
        onDispatch={() => undefined}
      />,
    );
    expect(text(harness.container)).toContain("Drafts stay local until the agent applies them.");

    let reloads = 0;
    await harness.render(
      <SpecsTab
        docs={[productDoc]}
        drafts={{}}
        selectedPath={productDoc.path}
        assetBase={undefined}
        changedPaths={[]}
        launchedRunId="run-dispatched"
        launchError={null}
        draftRunNotice={{
          runId: "run-dispatched",
          state: "applied",
          clearedPaths: [productDoc.path],
          retainedPaths: [],
          updatedPaths: [productDoc.path],
          summary: "reported 1 applied draft and cleared matching local state. Reload to load regenerated docs.",
        }}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDiscardDrafts={(paths) => discarded.push(paths)}
        onDispatch={() => undefined}
        onReload={() => { reloads += 1; }}
      />,
    );
    expect(text(harness.container.querySelector('[data-testid="ddd-draft-run-state"]') as HTMLElement)).toContain("Applied");
    await act(async () => (harness.container.querySelector('[data-testid="ddd-draft-run-reload"]') as HTMLButtonElement).click());
    expect(reloads).toBe(1);
  });

  test("SpecsTab resets the active markdown editor when the current draft is discarded", async () => {
    const originalNavigator = globalThis.navigator;
    const originalWindowNavigator = window.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "happy-dom" },
    });
    Object.defineProperty(window, "navigator", {
      configurable: true,
      value: { userAgent: "happy-dom" },
    });
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const staleDraft = `${productDoc.content}\nStale recovered draft\n`;

    function SpecsDiscardHarness() {
      const [drafts, setDrafts] = useState<Record<string, string>>({ [productDoc.path]: staleDraft });
      const [resetKey, setResetKey] = useState(0);
      const changedPaths = drafts[productDoc.path] ? [productDoc.path] : [];
      return (
        <SpecsTab
          docs={[productDoc]}
          drafts={drafts}
          selectedPath={productDoc.path}
          assetBase={undefined}
          changedPaths={changedPaths}
          launchedRunId={null}
          launchError={null}
          recoveredPaths={changedPaths}
          editorResetKey={resetKey}
          onSelectPath={() => undefined}
          onDraftChange={(path, markdown) => {
            setDrafts(markdown === productDoc.content ? {} : { [path]: markdown });
          }}
          onDiscardDrafts={() => {
            setDrafts({});
            setResetKey((key) => key + 1);
          }}
          onDispatch={() => undefined}
        />
      );
    }

    try {
      const harness = await mount(<SpecsDiscardHarness />);
      const editor = harness.container.querySelector('[data-testid="ddd-editor"]') as HTMLTextAreaElement;
      expect(editor.value).toContain("Stale recovered draft");
      expect(text(harness.container)).toContain("Unsaved");

      await act(async () => (harness.container.querySelector('[data-testid="ddd-discard-file"]') as HTMLButtonElement).click());
      await waitFor(() => {
        const resetEditor = harness.container.querySelector('[data-testid="ddd-editor"]') as HTMLTextAreaElement;
        expect(resetEditor.value).toBe(productDoc.content);
        expect(resetEditor.value).not.toContain("Stale recovered draft");
        expect(text(harness.container)).toContain("Clean");
      });

      const resetEditor = harness.container.querySelector('[data-testid="ddd-editor"]') as HTMLTextAreaElement;
      await act(async () => setInputValue(resetEditor, `${productDoc.content}\nFresh edit\n`));
      expect(resetEditor.value).toContain("Fresh edit");
      expect(resetEditor.value).not.toContain("Stale recovered draft");
      expect(text(harness.container)).toContain("Unsaved");
    } finally {
      Object.defineProperty(window, "navigator", { configurable: true, value: originalWindowNavigator });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    }
  });

  test("spec draft persistence stores only changed product docs", () => {
    window.localStorage.clear();
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const technicalDoc = docsContent.find((doc) => doc.level === "technical")!;
    saveSpecDrafts({
      [productDoc.path]: `${productDoc.content}\nLocal recovery\n`,
      [technicalDoc.path]: `${technicalDoc.content}\nIgnored technical edit\n`,
    });
    const loaded = loadSpecDrafts(docsContent);
    expect(loaded[productDoc.path]).toContain("Local recovery");
    expect(loaded[technicalDoc.path]).toBeUndefined();

    saveSpecDrafts({});
    expect(loadSpecDrafts(docsContent)).toEqual({});
    window.localStorage.clear();
  });

  test("draft reconciliation clears only applied matching drafts and preserves newer local edits", () => {
    const changedFiles = changedFilesFromMetaTicket({
      changedFiles: [
        { path: ".smithers/spec/content/overview.md", beforeMarkdown: "# Old\n", afterMarkdown: "# Applied\n" },
        { path: "product/guide.md", beforeMarkdown: "# Guide\n", afterMarkdown: "# Guide applied\n" },
        { path: "product/not-updated.md", beforeMarkdown: "# Old\n", afterMarkdown: "# New\n" },
      ],
    });
    const updatedPaths = updatedDocPathsFromSpec({ updated_files: [".smithers/spec/content/overview.md", "product/guide.md"] });
    const result = reconcileDraftsAfterRun(
      {
        "overview.md": "# Applied\n",
        "product/guide.md": "# Guide applied\nNewer local note\n",
        "product/not-updated.md": "# New\n",
      },
      changedFiles,
      updatedPaths,
    );

    expect(result.clearedPaths).toEqual(["overview.md"]);
    expect(result.retainedPaths.sort()).toEqual(["product/guide.md", "product/not-updated.md"]);
    expect(result.appliedPaths.sort()).toEqual(["overview.md", "product/guide.md"]);
    expect(result.nextDrafts["overview.md"]).toBeUndefined();
    expect(result.nextDrafts["product/guide.md"]).toContain("Newer local note");
  });

  test("SpecsTab tucks technical docs behind a menu, renders them read-only, and keeps per-file dispatch disabled", async () => {
    const technicalDoc = docsContent.find((doc) => doc.level === "technical")!;
    const harness = await mount(
      <SpecsTab
        docs={docsContent}
        drafts={{}}
        selectedPath={technicalDoc.path}
        assetBase={undefined}
        changedPaths={[]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    const callout = harness.container.querySelector('[data-testid="ddd-agent-docs-callout"]');
    expect(text(callout as HTMLElement)).toContain("asking your agent to read these");
    expect(harness.container.querySelector('[data-testid="ddd-technical-docs"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-testid="ddd-technical-doc-view"]')).not.toBeNull();
    expect(text(harness.container.querySelector('[data-testid="ddd-doc-generated-badge"]') as HTMLElement)).toContain("read-only");
    expect((harness.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true);
    // Product docs render as a first-class tree section.
    expect(text(harness.container)).toContain("Product docs");
  });

  test("SpecsTab renders technical markdown as a preview with mermaid and a raw source toggle", async () => {
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const technicalDoc = {
      path: "features/diagram-test.md",
      title: "Diagram Test",
      level: "technical" as const,
      content: [
        "# Diagram Test",
        "",
        "Readable `markdown` with [overview](overview.md).",
        "",
        "```mermaid",
        "graph TD",
        "  A[Audit] --> B[Triage]",
        "```",
        "",
        "```ts",
        "const status = \"ready\";",
        "```",
      ].join("\n"),
    };
    const selected: string[] = [];
    const harness = await mount(
      <SpecsTab
        docs={[productDoc, technicalDoc]}
        drafts={{}}
        selectedPath={technicalDoc.path}
        assetBase={undefined}
        changedPaths={[]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={(path) => selected.push(path)}
        onDraftChange={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(harness.container.querySelector('[data-testid="ddd-markdown-preview"]')).toBeTruthy();
    expect(harness.container.querySelector('[data-testid="ddd-mermaid-preview"]')).toBeTruthy();
    expect(text(harness.container)).toContain("Diagram Test");
    expect(text(harness.container)).toContain("const status");

    await act(async () => (harness.container.querySelector("button.doc-link") as HTMLButtonElement).click());
    expect(selected).toEqual([productDoc.path]);

    await act(async () => (harness.container.querySelector('[data-testid="ddd-technical-source-toggle"]') as HTMLButtonElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-technical-doc-source"]')).toBeTruthy();
    expect(text(harness.container)).toContain("```mermaid");
  });

  test("MarkdownPreview formats generated feature docs without raw markdown escapes", async () => {
    const generatedDoc = docsContent.find((doc) => doc.path === "features/open-code-review.md")!;
    const selected: string[] = [];
    const harness = await mount(
      <MarkdownPreview
        markdown={`${generatedDoc.content}\n\nEscaped docs\\_owner, <Task>, and **Severity:** critical.`}
        onLinkClick={(href) => selected.push(href)}
      />,
    );

    const body = text(harness.container);
    expect(harness.container.querySelector("blockquote strong")).toBeTruthy();
    expect(body).toContain("Status:");
    expect(body).toContain("Priority:");
    expect(body).toContain("docs_owner");
    expect(body).toContain("<Task>");
    expect(body).not.toContain("**Status:**");
    expect(body).not.toContain("docs\\_owner");
    expect([...harness.container.querySelectorAll("code")].map((node) => text(node))).toContain("pnpm -C .smithers test");

    const docsLink = harness.container.querySelector("button.doc-link") as HTMLButtonElement | null;
    if (docsLink) {
      await act(async () => docsLink.click());
      expect(selected.length).toBeGreaterThan(0);
    }
  });

  test("MarkdownPreview handles empty content, CRLF blocks, lists, inline code, external links, and unclosed fences", async () => {
    const empty = await mount(<MarkdownPreview markdown={" \r\n\t\n"} />);
    expect(text(empty.container)).toContain("No documentation content.");
    await empty.unmount();

    const clicked: string[] = [];
    const harness = await mount(
      <MarkdownPreview
        markdown={[
          "# Parser Edges\r\n",
          "> quoted first\r\n> quoted second",
          "",
          "- unordered `code` with [overview](overview.md)",
          "- second item",
          "",
          "1. ordered [external](https://example.com/docs)",
          "2. mail [support](mailto:support@example.com)",
          "",
          "Paragraph with `inline` plus [one](one.md) and [two](two.md#anchor).",
          "",
          "```ts",
          "const unclosed = true;",
        ].join("\r\n")}
        onLinkClick={(href) => clicked.push(href)}
      />,
    );

    expect(harness.container.querySelector("blockquote")).toBeTruthy();
    expect(text(harness.container.querySelector("blockquote") as HTMLElement)).toContain("quoted first");
    expect(harness.container.querySelectorAll("ul li")).toHaveLength(2);
    expect(harness.container.querySelectorAll("ol li")).toHaveLength(2);
    expect([...harness.container.querySelectorAll("code")].map((node) => text(node))).toEqual(
      expect.arrayContaining(["code", "inline", "const unclosed = true;"]),
    );
    expect((harness.container.querySelector('a[href="https://example.com/docs"]') as HTMLAnchorElement).target).toBe("_blank");
    expect(harness.container.querySelector('a[href="mailto:support@example.com"]')).toBeTruthy();

    const internalLinks = [...harness.container.querySelectorAll("button.doc-link")] as HTMLButtonElement[];
    expect(internalLinks.map((button) => text(button))).toEqual(["overview", "one", "two"]);
    for (const button of internalLinks) await act(async () => button.click());
    expect(clicked).toEqual(["overview.md", "one.md", "two.md#anchor"]);
  });

  test("SpecsTab MarkdownPreview ignores dead relative links and same-page anchors but opens resolved docs", async () => {
    const productDoc = {
      path: "overview.md",
      title: "Overview",
      level: "product" as const,
      content: "# Overview\n",
    };
    const technicalDoc = {
      path: "features/parser-edges.md",
      title: "Parser Edges",
      level: "technical" as const,
      content: [
        "# Parser Edges",
        "",
        "Jump to [dead](missing.md), [same](#local-section), and [overview](../overview.md).",
        "",
        "## Local Section",
      ].join("\n"),
    };
    const selected: string[] = [];
    const harness = await mount(
      <SpecsTab
        docs={[productDoc, technicalDoc]}
        drafts={{}}
        selectedPath={technicalDoc.path}
        assetBase={undefined}
        changedPaths={[]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={(path) => selected.push(path)}
        onDraftChange={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    const previewLinks = [...harness.container.querySelectorAll(".markdown-preview button.doc-link")] as HTMLButtonElement[];
    expect(previewLinks.map((button) => text(button))).toEqual(["dead", "same", "overview"]);
    for (const button of previewLinks) await act(async () => button.click());
    expect(selected).toEqual(["overview.md"]);
  });

  test("SpecsTab filters product and technical docs and marks dirty files in the tree", async () => {
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const technicalDoc = docsContent.find((doc) => doc.level === "technical")!;
    const selected: string[] = [];
    const harness = await mount(
      <SpecsTab
        docs={[productDoc, technicalDoc]}
        drafts={{ [productDoc.path]: `${productDoc.content}\nDirty line\n` }}
        selectedPath={productDoc.path}
        assetBase={undefined}
        changedPaths={[productDoc.path]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={(path) => selected.push(path)}
        onDraftChange={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(harness.container.querySelector(".tree-file.is-dirty")).toBeTruthy();
    const search = harness.container.querySelector('[data-testid="ddd-doc-search"]') as HTMLInputElement;
    await act(async () => setInputValue(search, technicalDoc.path.split("/").at(-1) ?? technicalDoc.path));
    expect(text(harness.container)).toContain("No product docs match.");
    await waitFor(() => expect(selected).toEqual([technicalDoc.path]));
    expect(harness.container.querySelector('[data-testid="ddd-technical-doc-view"]')).toBeTruthy();
    expect(text(harness.container.querySelector(".editor-title") as HTMLElement)).toContain(technicalDoc.path);
    const techButton = [...harness.container.querySelectorAll('[data-testid="ddd-tree-file"]')]
      .find((button) => text(button).includes(technicalDoc.path.split("/").at(-1) ?? technicalDoc.path)) as HTMLButtonElement;
    expect(techButton).toBeTruthy();
    await act(async () => techButton.click());
    expect(selected).toEqual([technicalDoc.path, technicalDoc.path]);
  });

  test("SpecsTab keeps dispatch-all disabled for technical-only changes", async () => {
    const technicalDoc = docsContent.find((doc) => doc.level === "technical")!;
    const dispatched: string[][] = [];
    const harness = await mount(
      <SpecsTab
        docs={docsContent}
        drafts={{ [technicalDoc.path]: `${technicalDoc.content}\nDirty technical line\n` }}
        selectedPath={technicalDoc.path}
        assetBase={undefined}
        changedPaths={[technicalDoc.path]}
        launchedRunId={null}
        launchError={null}
        onSelectPath={() => undefined}
        onDraftChange={() => undefined}
        onDispatch={(paths) => dispatched.push(paths)}
      />,
    );

    expect(harness.container.querySelector('[data-testid="ddd-technical-doc-view"]')).toBeTruthy();
    expect((harness.container.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.container.querySelector('[data-testid="ddd-create-meta-ticket"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text(harness.container)).toContain("Dispatch all changes");
    expect(text(harness.container)).not.toContain("Dispatch all changes (1)");
    expect(dispatched).toEqual([]);
  });

  test("SpecsTab editor link handling opens doc links and ignores dead, external, and anchor links", async () => {
    const productDoc = docsContent.find((doc) => doc.level === "product")!;
    const technicalDoc = docsContent.find((doc) => doc.path.startsWith("features/"))!;
    const originalNavigator = globalThis.navigator;
    const originalWindowNavigator = window.navigator;
    const originalOpen = window.open;
    const originalScroll = Element.prototype.scrollIntoView;
    const openedWindows: string[] = [];
    const selected: string[] = [];
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "real-browser" } });
    Object.defineProperty(window, "navigator", { configurable: true, value: { userAgent: "real-browser" } });
    Object.defineProperty(window, "open", {
      configurable: true,
      value: (url: string) => {
        openedWindows.push(url);
        return null;
      },
    });
    Element.prototype.scrollIntoView = function scrollIntoView() {
      this.setAttribute("data-scrolled", "true");
    };

    try {
      const harness = await mount(
        <SpecsTab
          docs={[productDoc, technicalDoc]}
          drafts={{}}
          selectedPath={productDoc.path}
          assetBase={undefined}
          changedPaths={[]}
          launchedRunId={null}
          launchError={null}
          onSelectPath={(path) => selected.push(path)}
          onDraftChange={() => undefined}
          onDispatch={() => undefined}
        />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const host = harness.container.querySelector(".crepe-host") as HTMLElement;
      host.innerHTML = [
        '<h2 id="local-anchor">Local anchor</h2>',
        '<a data-link="external" href="https://example.com/ddd">external</a>',
        '<a data-link="anchor" href="#local-anchor">anchor</a>',
        `<a data-link="relative" href="${technicalDoc.path}">relative</a>`,
        '<a data-link="dead" href="missing.md">dead</a>',
      ].join("");

      const click = async (selector: string) => {
        await act(async () => {
          host.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
      };

      await click('[data-link="external"]');
      await click('[data-link="anchor"]');
      await click('[data-link="dead"]');
      await click('[data-link="relative"]');

      expect(openedWindows).toEqual(["https://example.com/ddd"]);
      expect(host.querySelector("#local-anchor")?.getAttribute("data-scrolled")).toBe("true");
      expect(selected).toEqual([technicalDoc.path]);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      Object.defineProperty(window, "open", { configurable: true, value: originalOpen });
      Object.defineProperty(window, "navigator", { configurable: true, value: originalWindowNavigator });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    }
  });

  test("MarkdownEditor shows a readable Crepe failure with retry and textarea fallback", async () => {
    const originalNavigator = globalThis.navigator;
    const originalWindowNavigator = window.navigator;
    const originalGlobalMutationObserver = globalThis.MutationObserver;
    const originalMutationObserver = window.MutationObserver;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "real-browser" },
    });
    Object.defineProperty(window, "navigator", {
      configurable: true,
      value: { userAgent: "real-browser" },
    });
    Object.defineProperty(window, "MutationObserver", {
      configurable: true,
      value: class BrokenMutationObserver {
        constructor() {
          throw new Error("mutation observer unavailable");
        }
      },
    });
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      value: window.MutationObserver,
    });

    try {
      const edits: string[] = [];
      const harness = await mount(
        <MarkdownEditor
          docPath="overview.md"
          initialValue="# Overview\n"
          assetBase={undefined}
          onChange={(markdown) => edits.push(markdown)}
        />,
      );
      for (let i = 0; i < 20 && !harness.container.querySelector('[data-testid="ddd-editor-error"]'); i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }

      expect(text(harness.container)).toContain("Editor failed to load");
      expect(text(harness.container)).toContain("mutation observer unavailable");
      expect(harness.container.querySelector('[data-testid="ddd-editor-retry"]')).toBeTruthy();
      const fallback = harness.container.querySelector('[data-testid="ddd-editor-fallback"]') as HTMLTextAreaElement;
      expect(fallback.value).toContain("# Overview");
      await act(async () => setInputValue(fallback, "# Edited\n"));
      expect(edits.at(-1)).toBe("# Edited\n");
    } finally {
      Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: originalGlobalMutationObserver });
      Object.defineProperty(window, "MutationObserver", { configurable: true, value: originalMutationObserver });
      Object.defineProperty(window, "navigator", { configurable: true, value: originalWindowNavigator });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    }
  });

  test("MarkdownEditor textarea fallback preserves default value and reports edits", async () => {
    const originalNavigator = globalThis.navigator;
    const originalWindowNavigator = window.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "happy-dom" },
    });
    Object.defineProperty(window, "navigator", {
      configurable: true,
      value: { userAgent: "happy-dom" },
    });
    const changes: string[] = [];
    try {
      const harness = await mount(
        <MarkdownEditor
          docPath="overview.md"
          initialValue={"# Overview\n\nInitial body.\n"}
          assetBase={undefined}
          onChange={(markdown) => changes.push(markdown)}
        />,
      );

      const textarea = harness.container.querySelector('[data-testid="ddd-editor"]') as HTMLTextAreaElement;
      expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
      expect(textarea.value).toBe("# Overview\n\nInitial body.\n");

      await act(async () => setInputValue(textarea, "# Overview\n\nEdited body.\n"));
      expect(changes).toEqual(["# Overview\n\nEdited body.\n"]);
    } finally {
      Object.defineProperty(window, "navigator", { configurable: true, value: originalWindowNavigator });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    }
  });

  test("uploadAsset posts to a real asset server and rejects non-OK or missing-url responses", async () => {
    const seen: Array<{ path: string; filename: string; body: string }> = [];
    const responses = [
      { status: 200, body: { url: "/assets/one.png" } },
      { status: 503, body: { error: "down" } },
      { status: 200, body: {} },
    ];
    const { base } = await localJsonServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          filename: String(req.headers["x-filename"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const next = responses.shift() ?? { status: 500, body: {} };
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      });
    });

    await expect(uploadAsset(base, new File(["one"], "one.png"))).resolves.toBe("/assets/one.png");
    await expect(uploadAsset(base, new File(["two"], "two.png"))).rejects.toThrow("asset upload failed: 503");
    await expect(uploadAsset(base, new File(["three"], "three.png"))).rejects.toThrow("asset upload returned no url");
    expect(seen.map((item) => item.path)).toEqual(["/upload", "/upload", "/upload"]);
    expect(seen[0]).toMatchObject({ filename: "one.png", body: "one" });
  });

  test("AuditTab handles snake_case findings, note selection, output cards, and empty state", async () => {
    const opened: Array<{ feature: Feature; note?: string }> = [];
    const feature = features[0]!;
    const harness = await mount(
      <AuditTab
        audit={{
          generatedSiteBuilds: true,
          featureIds: [feature.id],
          broken: [],
          partial: [],
          missingE2E: [],
          missingDocs: [],
          notes: [],
          missing_e2e: [feature.id],
          missing_docs: [feature.id],
        } as any}
        bootstrap={{ summary: "bootstrap passed" }}
        spec={{ status: "ready", summary: "spec updated" }}
        metaTicket={{ summary: "meta ticket" }}
        summary={{ status: "partial", summary: "summary" }}
        triage={[{ slot: 1, title: "Triage DDD", agent: "codex", reason: "reason", taskType: "e2e" }]}
        onOpenFeature={(next, note) => opened.push({ feature: next, note })}
      />,
    );

    expect(harness.container.querySelectorAll('[data-testid="ddd-finding"]').length).toBe(2);
    expect(text(harness.container)).toContain("bootstrap passed");
    expect(text(harness.container)).toContain("Triage DDD");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-finding"]') as HTMLButtonElement).click());
    expect(opened[0]?.feature.id).toBe(feature.id);

    await harness.render(
      <AuditTab
        audit={null}
        bootstrap={null}
        spec={null}
        metaTicket={null}
        summary={null}
        triage={[]}
        onOpenFeature={() => undefined}
      />,
    );
    expect(text(harness.container)).toContain("No findings yet");
    expect(text(harness.container)).toContain("Start a run to populate");
  });

  test("AuditTab renders unknown feature findings and failed bootstrap build status", async () => {
    const opened: Feature[] = [];
    const harness = await mount(
      <AuditTab
        audit={{
          generatedSiteBuilds: false,
          featureIds: ["missing-feature"],
          broken: ["missing-feature"],
          partial: [],
          missingE2E: [],
          missingDocs: [],
          notes: ["missing-feature could not be matched"],
        }}
        bootstrap={{ docsBuildPassed: false, summary: "Spec build failed: invalid features.json" }}
        spec={null}
        metaTicket={null}
        summary={null}
        triage={[]}
        onOpenFeature={(feature) => opened.push(feature)}
      />,
    );

    expect(text(harness.container)).toContain("missing-feature");
    expect(text(harness.container)).toContain("Audit returned an unknown feature id");
    expect(text(harness.container)).toContain("Add this feature to features.json");
    expect(text(harness.container)).toContain("missing-feature could not be matched");
    expect(text(harness.container.querySelector('[data-testid="ddd-output-bootstrap"]') as HTMLElement)).toContain("Failed");
    expect(harness.container.querySelector('[data-testid="ddd-finding"]')).toBeFalsy();
    expect(harness.container.querySelector('[data-testid="ddd-unresolved-finding"]')).toBeTruthy();
    expect(opened).toEqual([]);
  });

  test("TicketsTab renders title extraction, fallback, status/null handling, modal open/close, and empty/loading states", async () => {
    const tickets: TicketRow[] = [
      {
        path: "tickets/one.md",
        kind: "ticket",
        status: "todo",
        updatedAtMs: 1,
        featureId: "feature-one",
        featureTitle: "Feature One",
        content: "# First ticket\n\nRun: run-1\nSlot: 1\nAgent: codex\nTask type: e2e\nSeverity: major\nFile: packages/core/src/index.ts\n\n## Gap\n\nBody",
      },
      { path: "tickets/two.md", kind: "issue", status: null, updatedAtMs: 0, content: "No heading" },
      { path: "tickets/snake.md", kind: "ticket", status: "todo", feature_id: "snake-feature", feature_title: "Snake Feature", content: "# Snake ticket" },
    ];
    const harness = await mount(<TicketsTab tickets={tickets} loading={false} />);

    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(3);
    expect(text(harness.container)).toContain("First ticket");
    expect(text(harness.container)).toContain("tickets/two.md");
    expect(text(harness.container)).toContain("Snake Feature");
    expect(text(harness.container)).toContain("Todo");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-ticket"]') as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const ticketDialog = harness.container.querySelector('[data-testid="ddd-ticket-detail"]') as HTMLElement;
    expect(ticketDialog).toBeTruthy();
    expect(ticketDialog.getAttribute("aria-labelledby")).toBe("ddd-ticket-detail-title");
    const ticketClose = ticketDialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(ticketClose);
    expect(text(harness.container)).toContain("Body");
    expect(text(harness.container)).toContain("Feature One");
    expect(text(harness.container)).toContain("run-1");
    expect(text(harness.container)).toContain("codex");
    expect(text(harness.container)).toContain("packages/core/src/index.ts");

    await act(async () => ticketClose.click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeFalsy();

    await act(async () => (harness.container.querySelectorAll('[data-testid="ddd-ticket"]')[1] as HTMLButtonElement).click());
    expect(text(harness.container)).toContain("Description");
    expect(text(harness.container)).toContain("No heading");
    expect(text(harness.container)).not.toContain("No detail recorded");

    await harness.render(<TicketsTab tickets={[]} loading />);
    expect(text(harness.container)).toContain("Loading tickets");
  });

  test("TicketsTab parses generated backlog metadata, filters, details, and closes by keyboard or backdrop", async () => {
    const generatedBacklogContent = [
      "# Add no-work dispatch coverage",
      "",
      "Feature: Docs driven development (docs-driven-development)",
      "Status: todo · Kind: e2e · Priority: P0 · Severity: major · Feature status: partial",
      "Run: run-1 · Slot: 2 · Agent: codex · Task type: e2e",
      "File: .smithers/tests/docs-driven-development-run.e2e.test.ts",
      "",
      "## Gap",
      "",
      "The common Specs-tab dispatch path should reach round-summary without work.",
      "Status: this line is part of the body shape and must not become top-level metadata.",
      "",
      "## Acceptance",
      "",
      "- metaTicket is created",
      "- work:1 is absent",
    ].join("\n");
    const tickets: TicketRow[] = [
      {
        ...(ticketsBacklog[0] as TicketRow),
        path: "tickets/generated-no-work.md",
        kind: "e2e",
        status: "todo",
        featureId: "",
        featureTitle: "",
        content: generatedBacklogContent,
      },
      {
        path: "tickets/fix-cli.md",
        kind: "fix",
        status: "in-progress",
        priority: "p2",
        updatedAtMs: 0,
        featureId: "cli",
        featureTitle: "smithers CLI",
        content: [
          "# Repair CLI read path",
          "",
          "Feature: smithers CLI (cli)",
          "Status: in-progress · Kind: fix · Priority: P2 · Feature status: partial",
          "File: apps/cli/src/index.ts",
          "",
          "## Gap",
          "",
          "Keep sqlite and pglite reads aligned.",
        ].join("\n"),
      },
    ];
    const harness = await mount(<TicketsTab tickets={tickets} loading={false} />);

    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(2);
    expect(text(harness.container)).toContain("Docs driven development (docs-driven-development)");
    expect(text(harness.container)).toContain(".smithers/tests/docs-driven-development-run.e2e.test.ts");
    expect(text(harness.container)).toContain("P0");
    expect(text(harness.container)).toContain("Major");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-ticket"]') as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeTruthy();
    const labels = [...harness.container.querySelectorAll(".ticket-meta span")].map((node) => text(node));
    expect(labels.slice(0, 11)).toEqual(["Status", "Kind", "Priority", "Severity", "Run", "Slot", "Agent", "Task type", "Feature", "Feature status", "File"]);
    expect(text(harness.container)).toContain("Todo");
    expect(text(harness.container)).toContain("P0");
    expect(text(harness.container)).toContain("Major");
    expect(text(harness.container)).toContain("The common Specs-tab dispatch path");
    expect(text(harness.container)).toContain("metaTicket is created");
    expect(text(harness.container)).toContain("work:1 is absent");
    expect(text(harness.container)).toContain("Status: this line is part of the body shape");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeFalsy();

    const search = harness.container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => setInputValue(search, "Repair CLI"));
    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(1);
    expect(text(harness.container)).toContain("Repair CLI read path");

    await act(async () => buttonByText(harness.container, "Clear").click());
    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(2);

    const [statusSelect, kindSelect, severitySelect, sortSelect] = [...harness.container.querySelectorAll("select")] as HTMLSelectElement[];
    expect([...kindSelect!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All kinds", "E2E", "Fix"]);
    expect([...severitySelect!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All severities", "Major"]);
    await act(async () => setSelectValue(statusSelect!, "todo"));
    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(1);
    expect(text(harness.container)).toContain("Add no-work dispatch coverage");

    await act(async () => setSelectValue(kindSelect!, "fix"));
    expect(text(harness.container)).toContain("No tickets match the current filters.");

    await act(async () => buttonByText(harness.container, "Clear").click());
    await act(async () => setSelectValue(severitySelect!, "major"));
    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(1);
    expect(text(harness.container)).toContain("Add no-work dispatch coverage");

    await act(async () => setSelectValue(sortSelect!, "title"));
    await act(async () => buttonByText(harness.container, "Clear").click());
    await act(async () => setInputValue(search, "definitely no matching ticket"));
    expect(text(harness.container)).toContain("No tickets match the current filters.");

    await act(async () => buttonByText(harness.container, "Clear").click());
    await act(async () => (harness.container.querySelector('[data-testid="ddd-ticket"]') as HTMLButtonElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeTruthy();
    await act(async () => (harness.container.querySelector(".modal-backdrop") as HTMLElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeFalsy();
  });

  test("TicketsTab covers no-detail tickets, sorted metadata rest entries, and deduped filter options", async () => {
    const tickets: TicketRow[] = [
      {
        path: "tickets/no-detail.md",
        content: "# No detail",
      },
      {
        path: "tickets/metadata.md",
        kind: "issue",
        status: "todo",
        content: [
          "# Metadata detail",
          "",
          "Zoo: last · Status: todo · Alpha: first · Kind: issue",
          "",
          "## Gap",
          "",
          "Metadata should be readable.",
        ].join("\n"),
      },
      {
        path: "tickets/duplicate.md",
        kind: "issue",
        status: "todo",
        content: "# Duplicate",
      },
    ];
    const harness = await mount(<TicketsTab tickets={tickets} loading={false} />);
    const [statusSelect, kindSelect] = [...harness.container.querySelectorAll("select")] as HTMLSelectElement[];
    expect([...statusSelect!.querySelectorAll("option")].map((option) => option.value)).toEqual(["all", "todo"]);
    expect([...kindSelect!.querySelectorAll("option")].map((option) => option.value)).toEqual(["all", "issue"]);
    expect([...kindSelect!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All kinds", "Issue"]);

    await act(async () => (harness.container.querySelector('[data-testid="ddd-ticket"]') as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text(harness.container)).toContain("No detail recorded for this ticket.");
    await act(async () => (harness.container.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());

    const metadataButton = [...harness.container.querySelectorAll('[data-testid="ddd-ticket"]')]
      .find((button) => text(button).includes("Metadata detail")) as HTMLButtonElement;
    await act(async () => metadataButton.click());
    const labels = [...harness.container.querySelectorAll(".ticket-meta span")].map((node) => text(node));
    expect(labels).toEqual(["Status", "Kind", "Alpha", "Zoo"]);
  });

  test("NewEntryMenu launches compact create and generate actions for existing specs", async () => {
    const created: string[] = [];
    let generateCount = 0;
    let open = true;
    const harness = await mount(
      <NewEntryMenu
        open={open}
        onOpenChange={(next) => { open = next; }}
        onCreateApp={(description) => created.push(description)}
        onGenerateDocs={() => { generateCount += 1; }}
        createState={{ runId: null, error: null }}
        generateState={{ runId: null, error: null }}
        bugScanRunId=""
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
      />,
    );

    expect(harness.container.querySelector('[data-testid="ddd-new-menu"]')).toBeTruthy();
    expect((harness.container.querySelector('[data-testid="ddd-new-create-launch"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => setInputValue(harness.container.querySelector('[data-testid="ddd-new-description"]') as HTMLTextAreaElement, "  Build a compact app  "));
    await act(async () => (harness.container.querySelector('[data-testid="ddd-new-create-launch"]') as HTMLButtonElement).click());
    await act(async () => (harness.container.querySelector('[data-testid="ddd-new-generate-launch"]') as HTMLButtonElement).click());
    expect(created).toEqual(["Build a compact app"]);
    expect(generateCount).toBe(1);

    await act(async () => (harness.container.querySelector('button[aria-label="Close new menu"]') as HTMLButtonElement).click());
    expect(open).toBe(false);
  });

  test("builderWorkflowName creates deterministic build workflow names from descriptions", () => {
    expect(builderWorkflowName("A markdown notes search app")).toBe("build-a-markdown-notes-search-app");
    expect(builderWorkflowName("!!!")).toBe("build-app");
    expect(builderWorkflowName("x".repeat(80))).toBe(`build-${"x".repeat(48)}`);
    expect(createWorkflowPromptForApp("A markdown notes search app")).toContain("workflow named build-a-markdown-notes-search-app");
    expect(createWorkflowPromptForApp("A markdown notes search app")).toContain("file slug must be exactly build-a-markdown-notes-search-app");
  });

  test("shouldPollKickoffNode stops polling once the kickoff row lands, the bug-scan id is known, or the generate run is terminal", () => {
    const base = { generateRunId: "gen-1", bugScanRunId: "", kickoffReady: false, generateRunStatus: "running" as string | undefined };
    // Poll while the generate run is live and no kickoff output has arrived.
    expect(shouldPollKickoffNode(base)).toBe(true);
    // No generate run to follow yet.
    expect(shouldPollKickoffNode({ ...base, generateRunId: null })).toBe(false);
    expect(shouldPollKickoffNode({ ...base, generateRunId: undefined })).toBe(false);
    // Bug-scan run id resolved (launched:true path).
    expect(shouldPollKickoffNode({ ...base, bugScanRunId: "scan-2" })).toBe(false);
    // Kickoff row produced with no run id (launched:false, gate-blocked, or an
    // unparsed launch) — the immutable output has been read once, so stop.
    expect(shouldPollKickoffNode({ ...base, kickoffReady: true })).toBe(false);
    // Generate run failed before the kickoff node ever ran.
    expect(shouldPollKickoffNode({ ...base, generateRunStatus: "failed" })).toBe(false);
    expect(shouldPollKickoffNode({ ...base, generateRunStatus: "finished" })).toBe(false);
  });

  test("StartPane validates trimmed descriptions, hides close in stub mode, and launches with trimmed text", async () => {
    const created: string[] = [];
    let generateCount = 0;
    let closed = 0;
    const harness = await mount(
      <StartPane
        stub
        onClose={null}
        onCreateApp={(description) => created.push(description)}
        onGenerateDocs={() => { generateCount += 1; }}
        createState={{ runId: null, error: null }}
        generateState={{ runId: null, error: null }}
        bugScanRunId=""
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
      />,
    );

    expect(harness.container.querySelector('button[aria-label="Close"]')).toBeFalsy();
    const launch = harness.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement;
    expect(launch.disabled).toBe(true);

    const textarea = harness.container.querySelector('[data-testid="ddd-start-description"]') as HTMLTextAreaElement;
    await act(async () => setInputValue(textarea, "   short  "));
    expect(launch.disabled).toBe(true);

    await act(async () => setInputValue(textarea, "   Build a docs-first app   "));
    expect(launch.disabled).toBe(false);
    await act(async () => launch.click());
    expect(created).toEqual(["Build a docs-first app"]);

    await act(async () => (harness.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).click());
    expect(generateCount).toBe(1);

    await harness.render(
      <StartPane
        stub={false}
        onClose={() => { closed += 1; }}
        onCreateApp={(description) => created.push(description)}
        onGenerateDocs={() => { generateCount += 1; }}
        createState={{ runId: null, error: null }}
        generateState={{ runId: null, error: null }}
        bugScanRunId=""
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
      />,
    );
    const close = harness.container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close).toBeTruthy();
    await act(async () => close.click());
    expect(closed).toBe(1);
  });

  test("StartPane launch states disable buttons and render errors, run links, and bug-scan status", async () => {
    let reloads = 0;
    const harness = await mount(
      <StartPane
        stub={false}
        onClose={() => undefined}
        onCreateApp={() => undefined}
        onGenerateDocs={() => undefined}
        createState={{ runId: "create-run-1", error: null }}
        generateState={{ runId: "generate-run-1", error: null }}
        bugScanRunId="bug-run-1"
        bugScanSummary=""
        workflowUiHref={(workflow, runId) => `/workflows/${encodeURIComponent(workflow)}?runId=${encodeURIComponent(runId)}`}
        onReload={() => { reloads += 1; }}
      />,
    );

    expect((harness.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text(harness.container)).toContain("create-workflow is designing the builder.");
    expect(text(harness.container)).toContain("ddd-generate-docs is reading your repo.");
    expect(text(harness.container)).toContain("bug-run-1");
    const link = harness.container.querySelector('[data-testid="ddd-start-launched"] a') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workflows/create-workflow?runId=create-run-1");
    const generateLink = harness.container.querySelector('[data-testid="ddd-start-generate-run"] a') as HTMLAnchorElement;
    expect(generateLink.getAttribute("href")).toBe("/workflows/ddd-generate-docs?runId=generate-run-1");
    const bugScanLink = harness.container.querySelector('[data-testid="ddd-start-bug-scan"] a') as HTMLAnchorElement;
    expect(bugScanLink.getAttribute("href")).toBe("/workflows/ddd-bug-scan?runId=bug-run-1");
    expect(text(harness.container.querySelector('[data-testid="ddd-start-reload-path"]') as HTMLElement)).toContain("reload this UI");
    await act(async () => (harness.container.querySelector('[data-testid="ddd-start-reload"]') as HTMLButtonElement).click());
    expect(reloads).toBe(1);

    await harness.render(
      <StartPane
        stub={false}
        onClose={() => undefined}
        onCreateApp={() => undefined}
        onGenerateDocs={() => undefined}
        createState={{ runId: "create-run-1", error: null, status: "finished" }}
        generateState={{ runId: "generate-run-1", error: null, status: "failed" }}
        bugScanRunId=""
        bugScanSummary=""
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
        onReload={() => { reloads += 1; }}
      />,
    );
    await act(async () => setInputValue(harness.container.querySelector('[data-testid="ddd-start-description"]') as HTMLTextAreaElement, "Build another app"));
    expect((harness.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement).disabled).toBe(false);
    expect((harness.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).disabled).toBe(false);
    expect(text(harness.container)).toContain("Finished");
    expect(text(harness.container)).toContain("Failed");
    expect(text(harness.container)).toContain("Ready for another launch");
    expect(text(harness.container)).toContain("Create another app + builder workflow");
    expect(text(harness.container)).toContain("Generate docs again");

    await harness.render(
      <StartPane
        stub={false}
        onClose={() => undefined}
        onCreateApp={() => undefined}
        onGenerateDocs={() => undefined}
        createState={{ runId: null, error: null, pending: true }}
        generateState={{ runId: null, error: null, pending: true }}
        bugScanRunId=""
        bugScanSummary=""
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
        onReload={() => { reloads += 1; }}
      />,
    );
    expect((harness.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text(harness.container)).toContain("Launching builder");
    expect(text(harness.container)).toContain("Launching docs");
    expect(harness.container.querySelector('[data-testid="ddd-start-launched-launching"]')).toBeTruthy();
    expect(harness.container.querySelector('[data-testid="ddd-start-generate-run-launching"]')).toBeTruthy();

    await harness.render(
      <StartPane
        stub={false}
        onClose={() => undefined}
        onCreateApp={() => undefined}
        onGenerateDocs={() => undefined}
        createState={{ runId: null, error: "create failed" }}
        generateState={{ runId: null, error: "generate failed" }}
        bugScanRunId=""
        bugScanSummary="Bug scan blocked because the generated spec build failed."
        workflowUiHref={(workflow, runId) => `/workflows/${workflow}?runId=${runId}`}
        onReload={() => { reloads += 1; }}
      />,
    );
    expect(harness.container.querySelectorAll('[data-testid="ddd-start-error"]').length).toBe(2);
    expect(text(harness.container)).toContain("create failed");
    expect(text(harness.container)).toContain("generate failed");
    expect(harness.container.querySelector('[data-testid="ddd-start-bug-scan-blocked"]')).toBeTruthy();
    expect(text(harness.container)).toContain("generated spec build failed");
  });

  test("Tutorial storage helpers cover available storage, unavailable storage, URL suppression, and completion", () => {
    window.localStorage.clear();
    setWindowUrl("/workflows/docs-driven-development");
    expect(tutorialStorageAvailable()).toBe(true);
    expect(tutorialDone()).toBe(false);
    expect(shouldShowTutorial()).toBe(true);

    markTutorialDone();
    expect(tutorialDone()).toBe(true);
    expect(shouldShowTutorial()).toBe(false);

    window.localStorage.clear();
    expect(tutorialDisabledByUrl("?tutorial=off")).toBe(true);
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { search: "?tutorial=off" },
    });
    try {
      expect(shouldShowTutorial()).toBe(false);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }

    const originalStorage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
        removeItem: () => { throw new Error("blocked"); },
      },
    });
    try {
      expect(tutorialStorageAvailable()).toBe(false);
      expect(tutorialDone()).toBe(false);
      expect(() => markTutorialDone()).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: originalStorage });
      setWindowUrl("/workflows/docs-driven-development");
      window.localStorage.clear();
    }
  });

  test("Tutorial navigates within bounds, skip and finish mark done, reset to first step, and call onClose", async () => {
    window.localStorage.clear();
    let closes = 0;
    const harness = await mount(<Tutorial open onClose={() => { closes += 1; }} />);

    expect((harness.container.querySelector('[role="dialog"]') as HTMLElement).getAttribute("aria-labelledby")).toBe("ddd-tutorial-title");
    expect(text(harness.container)).toContain("1 / 5");
    const back = buttonByText(harness.container, "Back");
    expect(back.disabled).toBe(true);

    const next = harness.container.querySelector('[data-testid="ddd-tutorial-next"]') as HTMLButtonElement;
    await act(async () => next.click());
    expect(text(harness.container)).toContain("2 / 5");
    expect(back.disabled).toBe(false);

    await act(async () => back.click());
    expect(text(harness.container)).toContain("1 / 5");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-tutorial-skip"]') as HTMLButtonElement).click());
    expect(closes).toBe(1);
    expect(tutorialDone()).toBe(true);

    window.localStorage.clear();
    await harness.render(<Tutorial open={false} onClose={() => { closes += 1; }} />);
    await harness.render(<Tutorial open onClose={() => { closes += 1; }} />);
    expect(text(harness.container)).toContain("1 / 5");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(harness.container.querySelector('[data-testid="ddd-tutorial-next"]'));

    for (let i = 0; i < 4; i += 1) {
      await act(async () => (harness.container.querySelector('[data-testid="ddd-tutorial-next"]') as HTMLButtonElement).click());
    }
    expect(text(harness.container)).toContain("5 / 5");
    expect(text(harness.container)).toContain("Start building");
    await act(async () => (harness.container.querySelector('[data-testid="ddd-tutorial-next"]') as HTMLButtonElement).click());
    expect(closes).toBe(2);
    expect(tutorialDone()).toBe(true);

    await harness.render(<Tutorial open={false} onClose={() => { closes += 1; }} />);
    await harness.render(<Tutorial open onClose={() => { closes += 1; }} />);
    expect(text(harness.container)).toContain("1 / 5");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closes).toBe(3);
    expect(tutorialDone()).toBe(true);

    window.localStorage.clear();
    await harness.render(<Tutorial open={false} onClose={() => { closes += 1; }} />);
    await harness.render(<Tutorial open onClose={() => { closes += 1; }} />);
    await act(async () => (harness.container.querySelector('button[aria-label="Close tutorial"]') as HTMLButtonElement).click());
    expect(closes).toBe(4);
    expect(tutorialDone()).toBe(true);
  });

  test("LiveTab surfaces run event and run tree errors", async () => {
    const harness = await mount(
      <LiveTab
        runs={[{ runId: "run-1", workflowKey: "docs-driven-development", status: "running" }]}
        runsLoading={false}
        selectedRunId="run-1"
        onSelectRun={() => undefined}
        runStatus="running"
        runTree={{ root: null, nodes: [], status: "failed", isLoading: false, error: new Error("tree failed") }}
        events={[]}
        eventsError={new Error("events failed")}
        streaming={false}
        assetBase={undefined}
      />,
    );

    expect(harness.container.querySelector('[data-testid="ddd-error-banner"]')).toBeTruthy();
    expect(text(harness.container)).toContain("tree failed");
    expect(text(harness.container)).toContain("events failed");
  });

  test("LiveTab filters runs by id, workflow, status, and reports formatted counts", async () => {
    const harness = await mount(
      <LiveTab
        runs={[
          { runId: "docs-run-alpha-1234567890", workflowKey: "docs-driven-development", status: "finished", createdAtMs: Date.UTC(2026, 0, 2, 3, 4) },
          { runId: "generate-run-beta-1234567890", workflowKey: "ddd-generate-docs", status: "running", createdAtMs: Date.UTC(2026, 0, 3, 3, 4) },
          { runId: "bug-run-gamma-1234567890", workflowKey: "ddd-bug-scan", status: "failed", createdAtMs: Date.UTC(2026, 0, 4, 3, 4) },
        ]}
        runsLoading={false}
        selectedRunId={undefined}
        onSelectRun={() => undefined}
        runStatus={undefined}
        runTree={{ root: null, nodes: [], status: "queued", isLoading: false, error: undefined }}
        events={[]}
        eventsError={undefined}
        streaming={false}
        assetBase={undefined}
      />,
    );

    const runList = harness.container.querySelector('[data-testid="ddd-run-list"]') as HTMLElement;
    expect(text(runList)).toContain("3 runs");
    expect(runList.querySelectorAll(".run-row").length).toBe(3);
    expect((runList.querySelector(".rid") as HTMLElement).getAttribute("title")).toBe("docs-run-alpha-1234567890");
    expect(text(runList)).toContain("docs-run-alp...34567890");

    const search = harness.container.querySelector('[data-testid="ddd-run-search"]') as HTMLInputElement;
    await act(async () => setInputValue(search, "generate"));
    expect(runList.querySelectorAll(".run-row").length).toBe(1);
    expect(text(runList)).toContain("1 run of 3 runs");
    expect(text(runList)).toContain("ddd-generate-docs");

    await act(async () => setInputValue(search, "no matching run"));
    expect(runList.querySelectorAll(".run-row").length).toBe(0);
    expect(text(runList)).toContain("No runs match the current filters.");

    await act(async () => buttonByText(runList, "Clear").click());
    const status = harness.container.querySelector('[data-testid="ddd-run-status-filter"]') as HTMLSelectElement;
    await act(async () => setSelectValue(status, "failed"));
    expect(runList.querySelectorAll(".run-row").length).toBe(1);
    expect(text(runList)).toContain("Failed");
    expect(text(runList)).toContain("1 run of 3 runs");
  });

  test("buildChatLines preserves cumulative transcripts from multiple agent sessions", () => {
    const lines = buildChatLines([
      {
        seq: 1,
        payload: {
          event: "agent.session",
          payload: {
            nodeId: "audit",
            sessionId: "audit-session",
            transcript: [{ role: "assistant", content: "audit first pass" }],
          },
        },
      },
      {
        seq: 2,
        payload: {
          event: "agent.session",
          payload: {
            nodeId: "triage",
            sessionId: "triage-session",
            transcript: [{ role: "assistant", content: "triage first pass" }],
          },
        },
      },
      {
        seq: 3,
        payload: {
          event: "agent.session",
          payload: {
            nodeId: "audit",
            sessionId: "audit-session",
            transcript: [
              { role: "assistant", content: "audit first pass" },
              { role: "assistant", content: "audit final finding" },
            ],
          },
        },
      },
      {
        seq: 4,
        payload: {
          event: "agent.event",
          payload: {
            nodeId: "audit",
            event: { type: "completed", answer: "audit final finding" },
          },
        },
      },
      {
        seq: 5,
        payload: {
          event: "agent.session",
          payload: {
            nodeId: "review",
            sessionId: "review-session",
            transcript: [{ role: "assistant", content: "triage first pass" }],
          },
        },
      },
    ]);

    expect(lines.map((line) => line.text)).toEqual([
      "audit first pass",
      "audit final finding",
      "triage first pass",
      "triage first pass",
    ]);
  });

  test("LiveTab loads persisted run events, merges by seq, renders recursive nodes, and selects runs", async () => {
    const persistedEvents = [
      {
        seq: 2,
        payload: { event: "task.output", payload: { nodeId: "work:1", output: "persisted duplicate should be replaced" } },
      },
      {
        seq: 1,
        payload: {
          event: "agent.session",
          payload: { transcript: [{ role: "assistant", content: [{ type: "text", text: "persisted assistant line" }] }] },
        },
      },
      {
        seq: 4,
        payload: { event: "node.finished", payload: { nodeId: "round-summary", status: "done" } },
      },
    ];
    const requested: string[] = [];
    const { base } = await localJsonServer((req, res) => {
      requested.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: persistedEvents }));
    });
    const selected: string[] = [];
    const harness = await mount(
      <LiveTab
        runs={[
          { runId: "run-1", workflowKey: "docs-driven-development", status: "finished" },
          { runId: "run-2", workflowKey: "docs-driven-development", status: "running" },
        ]}
        runsLoading={false}
        selectedRunId="run-1"
        onSelectRun={(runId) => selected.push(runId)}
        runStatus="running"
        runTree={{
          root: {
            id: "root",
            cardLabel: "bootstrap",
            status: "done",
            children: [
              {
                id: "child",
                name: "work:1",
                status: "running",
                agent: "codex",
                children: [{ id: "grandchild", name: "round-summary", status: "pending" }],
              },
            ],
          } as any,
          nodes: [],
          status: "running",
          isLoading: false,
          error: undefined,
        }}
        events={[
          {
            seq: 2,
            payload: { event: "task.output", payload: { nodeId: "work:1", output: "live duplicate wins" } },
          },
          {
            seq: 3,
            payload: { event: "agent.event", payload: { nodeId: "work:1", engine: "codex", event: { type: "completed", answer: "live assistant line" } } },
          },
        ]}
        eventsError={undefined}
        streaming
        assetBase={base}
      />,
    );

    await waitFor(() => expect(text(harness.container)).toContain("persisted assistant line"));
    expect(requested).toEqual(["/run-events?runId=run-1&limit=1000"]);
    expect(text(harness.container)).toContain("bootstrap");
    expect(text(harness.container)).toContain("work:1");
    expect(text(harness.container)).toContain("round-summary");
    expect(text(harness.container)).toContain("codex");
    expect(text(harness.container)).toContain("live duplicate wins");
    expect(text(harness.container)).toContain("live assistant line");
    expect(text(harness.container)).not.toContain("persisted duplicate should be replaced");
    expect(harness.container.querySelector(".livelog-debug")).toBeFalsy();
    expect(text(harness.container.querySelector('[data-testid="ddd-live-log"]') as HTMLElement)).not.toContain('"nodeId"');

    await act(async () => ([...harness.container.querySelectorAll(".run-row")]
      .find((row) => text(row).includes("run-2")) as HTMLButtonElement).click());
    expect(selected).toEqual(["run-2"]);
  });

  test("LiveTab reports persisted event failures and does not fetch without run or asset base", async () => {
    let requestCount = 0;
    const { base } = await localJsonServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    });
    const emptyTree = { root: null, nodes: [], status: "idle", isLoading: false, error: undefined } as any;

    const harness = await mount(
      <LiveTab
        runs={[{ runId: "run-1", workflowKey: "docs-driven-development", status: "running" }]}
        runsLoading={false}
        selectedRunId="run-1"
        onSelectRun={() => undefined}
        runStatus="running"
        runTree={emptyTree}
        events={[]}
        eventsError={undefined}
        streaming={false}
        assetBase={base}
      />,
    );

    await waitFor(() => expect(text(harness.container)).toContain("Saved run events could not be loaded"));
    expect(requestCount).toBe(1);

    await harness.render(
      <LiveTab
        runs={[]}
        runsLoading
        selectedRunId={undefined}
        onSelectRun={() => undefined}
        runStatus={undefined}
        runTree={emptyTree}
        events={[]}
        eventsError={undefined}
        streaming={false}
        assetBase={base}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(requestCount).toBe(1);
    expect(text(harness.container)).toContain("Loading runs...");
    expect(text(harness.container)).toContain("Select a run");

    await harness.render(
      <LiveTab
        runs={[]}
        runsLoading={false}
        selectedRunId="run-without-asset"
        onSelectRun={() => undefined}
        runStatus={undefined}
        runTree={{ ...emptyTree, isLoading: true }}
        events={[]}
        eventsError={undefined}
        streaming={false}
        assetBase={undefined}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(requestCount).toBe(1);
    expect(text(harness.container)).toContain("No docs-driven-development runs yet");
    expect(text(harness.container)).toContain("Loading tree...");
    expect(text(harness.container)).toContain("No agent chat output yet");
    expect(text(harness.container)).toContain("No events yet for this run.");
  });

  test("LiveTab shows the bundled source for the selected DDD workflow", async () => {
    const harness = await mount(
      <LiveTab
        runs={[{ runId: "generate-run", workflowKey: "ddd-generate-docs", status: "running" }]}
        runsLoading={false}
        selectedRunId="generate-run"
        selectedWorkflowKey="ddd-generate-docs"
        onSelectRun={() => undefined}
        runStatus="running"
        runTree={{ root: null, nodes: [], status: "running", isLoading: false, error: undefined }}
        events={[]}
        eventsError={undefined}
        streaming={false}
        assetBase={undefined}
      />,
    );

    const source = harness.container.querySelector('[data-testid="ddd-workflow-source"]') as HTMLElement;
    expect(source).toBeTruthy();
    expect(text(source)).toContain(".smithers/workflows/ddd-generate-docs.tsx");
    expect(text(source)).toContain("DDD Generate Docs");
  });
});
