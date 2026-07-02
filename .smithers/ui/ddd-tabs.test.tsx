/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined") {
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
  });

  test("SpecFileTree groups nested directories and reports selected files", async () => {
    const selected: string[] = [];
    const harness = await mount(
      <SpecFileTree
        files={[{ path: "overview.md" }, { path: "features/cli.md" }, { path: "reference/api.md" }]}
        selectedPath="features/cli.md"
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

    const firstDoc = docsContent[0]!;
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
      { path: "tickets/one.md", kind: "ticket", status: "todo", updatedAtMs: 1, content: "# First ticket\n\n## Gap\n\nBody" },
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

    await act(async () => (harness.container.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
    expect(harness.container.querySelector('[data-testid="ddd-ticket-detail"]')).toBeFalsy();

    await harness.render(<TicketsTab tickets={[]} loading />);
    expect(text(harness.container)).toContain("Loading tickets");
  });
});
