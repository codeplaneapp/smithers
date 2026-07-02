/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined" || !document?.createElement) {
  GlobalRegistrator.register();
}

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Feature, TicketRow } from "./ddd-shared";

const { docsContent } = await import("./ddd-docsContent.generated");
const { FeatureDetail, SpecFileTree, features } = await import("./ddd-shared");
const { FeaturesTab } = await import("./ddd-FeaturesTab");
const { SpecsTab } = await import("./ddd-SpecsTab");
const { AuditTab } = await import("./ddd-AuditTab");
const { TicketsTab } = await import("./ddd-TicketsTab");
const { LiveTab } = await import("./ddd-LiveTab");
const { StartPane } = await import("./ddd-StartPane");
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

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.unmount();
  document.body.innerHTML = "";
});

async function mount(element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
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
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  (input as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(previous);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function buttonByText(container: Element, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => text(candidate).includes(label));
  if (!button) throw new Error(`missing button: ${label}`);
  return button as HTMLButtonElement;
}

describe("DDD tabs and components", () => {
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
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(2);
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
    const techButton = [...harness.container.querySelectorAll('[data-testid="ddd-tree-file"]')]
      .find((button) => text(button).includes(technicalDoc.path.split("/").at(-1) ?? technicalDoc.path)) as HTMLButtonElement;
    expect(techButton).toBeTruthy();
    await act(async () => techButton.click());
    expect(selected).toEqual([technicalDoc.path]);
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
    ];
    const harness = await mount(<TicketsTab tickets={tickets} loading={false} />);

    expect(harness.container.querySelectorAll('[data-testid="ddd-ticket"]').length).toBe(2);
    expect(text(harness.container)).toContain("First ticket");
    expect(text(harness.container)).toContain("tickets/two.md");
    expect(text(harness.container)).toContain("Todo");

    await act(async () => (harness.container.querySelector('[data-testid="ddd-ticket"]') as HTMLButtonElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeTruthy();
    expect(text(harness.container)).toContain("Body");
    expect(text(harness.container)).toContain("Feature One");
    expect(text(harness.container)).toContain("run-1");
    expect(text(harness.container)).toContain("codex");
    expect(text(harness.container)).toContain("packages/core/src/index.ts");

    await act(async () => (harness.container.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeFalsy();

    await harness.render(<TicketsTab tickets={[]} loading />);
    expect(text(harness.container)).toContain("Loading tickets");
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
      />,
    );

    expect((harness.container.querySelector('[data-testid="ddd-start-create-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.container.querySelector('[data-testid="ddd-start-generate-launch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text(harness.container)).toContain("create-workflow is designing the builder.");
    expect(text(harness.container)).toContain("ddd-generate-docs is reading your repo.");
    expect(text(harness.container)).toContain("bug-run-1");
    const link = harness.container.querySelector('[data-testid="ddd-start-launched"] a') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workflows/create-workflow?runId=create-run-1");

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
    window.history.replaceState(null, "", "/workflows/docs-driven-development");
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
      window.history.replaceState(null, "", "/workflows/docs-driven-development");
      window.localStorage.clear();
    }
  });

  test("Tutorial navigates within bounds, skip and finish mark done, reset to first step, and call onClose", async () => {
    window.localStorage.clear();
    let closes = 0;
    const harness = await mount(<Tutorial open onClose={() => { closes += 1; }} />);

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
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closes).toBe(3);
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
});
