/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeGraph } from "../src/vault/KnowledgeGraph";
import type { VaultLink, VaultNoteMeta } from "../src/vault/types";

const NOTES: VaultNoteMeta[] = [
  { path: "Areas/Marketing.md", title: "Marketing", linksOut: ["People/Ada.md"] },
  { path: "People/Ada.md", title: "Ada", linksOut: ["Areas/Marketing.md", "HQ.md", "Inbox.md"] },
  { path: "HQ.md", title: "HQ", linksOut: ["People/Ada.md", "Areas/Marketing.md", "Inbox.md"] },
  { path: "Inbox.md", title: "Inbox", linksOut: ["People/Ada.md", "HQ.md"] },
];
const LINKS: VaultLink[] = [
  { source: "Areas/Marketing.md", target: "People/Ada.md" },
  { source: "People/Ada.md", target: "Areas/Marketing.md" },
  { source: "People/Ada.md", target: "HQ.md" },
  { source: "People/Ada.md", target: "Inbox.md" },
  { source: "HQ.md", target: "People/Ada.md" },
  { source: "HQ.md", target: "Areas/Marketing.md" },
  { source: "HQ.md", target: "Inbox.md" },
  { source: "Inbox.md", target: "People/Ada.md" },
  { source: "Inbox.md", target: "HQ.md" },
];
// Degrees under LINKS: Ada 5, HQ 5, Inbox 3, Marketing 2 — nobody reaches
// the hub label threshold of 6, so add two more edges for the label test.
const HUB_LINKS: VaultLink[] = [
  ...LINKS,
  { source: "Areas/Marketing.md", target: "HQ.md" },
  { source: "Areas/Marketing.md", target: "Inbox.md" },
];
// Now: Ada 6, HQ 6, Inbox 4, Marketing 4 — Ada and HQ are hubs.

describe("KnowledgeGraph (server render)", () => {
  test("renders the SVG with one circle per note and hub-only labels", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={HUB_LINKS} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Vault link graph"');
    expect(html.match(/<circle/g)).toHaveLength(4);
    // Only the degree-6 hubs (Ada, HQ) get labels.
    expect(html.match(/sui-vault-graph-label/g)).toHaveLength(2);
    expect(html).toContain(">HQ</text>");
    expect(html).toContain(">Ada</text>");
    // Folder tinting is assigned via data-tint.
    expect(html).toContain("data-tint=");
    // Header tally.
    expect(html).toContain("4 notes · 11 links");
  });

  test("renders edges as lines", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={LINKS} />);
    expect(html.match(/<line/g)).toHaveLength(LINKS.length);
  });

  test("first paint (pre-physics) is already spread out — nothing stacked at the origin", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={HUB_LINKS} />);
    const nodeTransforms = Array.from(
      html.matchAll(/<g[^>]*class="sui-vault-graph-node"[^>]*transform="([^"]+)"/g),
      (match) => match[1],
    );
    expect(nodeTransforms).toHaveLength(NOTES.length);
    expect(nodeTransforms).not.toContain("translate(0 0)");
    expect(html).not.toContain('x1="0"');
    expect(html).not.toContain('y2="0"');
  });

  test("empty vault renders the empty state", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={[]} links={[]} />);
    expect(html).toContain("No graph");
    expect(html).toContain("No wikilinks found across the vault.");
    expect(html).not.toContain("<svg");
  });
});

describe("KnowledgeGraph (physics unavailable)", () => {
  test("falls back to a clickable hub list when d3-force cannot load", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const opened: string[] = [];
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph
            notes={NOTES}
            links={HUB_LINKS}
            onOpenNote={(path) => opened.push(path)}
            loadPhysics={() => Promise.reject(new Error("d3-force unavailable"))}
          />,
        );
      });
      // Let the injected physics loader reject.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const fallback = container.querySelector('[data-slot="vault-graph-fallback"]');
      expect(fallback).toBeTruthy();
      const labels = Array.from(container.querySelectorAll(".sui-vault-link-label")).map((el) => el.textContent);
      // Sorted by degree desc; Ada and HQ tie at 6 and keep notes order.
      expect(labels.slice(0, 2)).toEqual(["Ada", "HQ"]);
      const firstRow = container.querySelector<HTMLElement>('[data-slot="row-button"]');
      await act(async () => {
        firstRow!.click();
      });
      expect(opened).toEqual(["People/Ada.md"]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
