import { describe, expect, test } from "bun:test";
import {
  HUB_LABEL_MIN_DEGREE,
  computeGraphModel,
  folderHue,
  folderTint,
  folderTintIndex,
  neighbourSet,
  nodeRadius,
  noteFolder,
  shouldShowLabel,
} from "../src/vault/graphModel";
import type { VaultLink, VaultNoteMeta } from "../src/vault/types";

const NOTES: VaultNoteMeta[] = [
  { path: "Areas/Marketing.md", title: "Marketing", linksOut: ["People/Ada.md"] },
  { path: "People/Ada.md", title: "Ada", linksOut: ["Areas/Marketing.md", "Missing.md"] },
  { path: "Inbox.md", title: "Inbox", linksOut: [] },
];
const LINKS: VaultLink[] = [
  { source: "Areas/Marketing.md", target: "People/Ada.md" },
  { source: "People/Ada.md", target: "Areas/Marketing.md" },
  { source: "People/Ada.md", target: "Missing.md" },
];

describe("folderHue", () => {
  test("is stable and within hue range", () => {
    expect(folderHue("Areas")).toBe(folderHue("Areas"));
    for (const folder of ["", "Areas", "People", "Research/overnight-2026-07-27"]) {
      const hue = folderHue(folder);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test("different folders usually hash differently", () => {
    expect(folderHue("Areas")).not.toBe(folderHue("People"));
  });
});

describe("folderTint", () => {
  test("rotates within the house tint palette and is stable per folder", () => {
    const tints = new Set(["brand", "success", "info", "warning"]);
    expect(tints.has(folderTint("Areas"))).toBe(true);
    expect(folderTint("Areas")).toBe(folderTint("Areas"));
    expect(folderTintIndex("Areas")).toBe(folderHue("Areas") % 4);
  });
});

describe("nodeRadius", () => {
  test("scales sublinearly with degree", () => {
    expect(nodeRadius(0)).toBe(3);
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(16)).toBeGreaterThan(nodeRadius(4));
    // sqrt scaling: quadrupling degree less than doubles the radius bump
    expect(nodeRadius(16) - nodeRadius(0)).toBeLessThan((nodeRadius(4) - nodeRadius(0)) * 4);
  });
});

describe("shouldShowLabel", () => {
  test("only labels hubs at or above the threshold", () => {
    expect(shouldShowLabel(HUB_LABEL_MIN_DEGREE - 1)).toBe(false);
    expect(shouldShowLabel(HUB_LABEL_MIN_DEGREE)).toBe(true);
    expect(shouldShowLabel(HUB_LABEL_MIN_DEGREE + 10)).toBe(true);
    expect(shouldShowLabel(3, 3)).toBe(true);
  });
});

describe("computeGraphModel", () => {
  test("tallies in/out/degree per note", () => {
    const { nodes } = computeGraphModel(NOTES, LINKS);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("Areas/Marketing.md")).toMatchObject({
      in: 1,
      out: 1,
      degree: 2,
      label: "Marketing",
      folder: "Areas",
    });
    expect(byId.get("People/Ada.md")).toMatchObject({ in: 1, out: 2, degree: 3 });
    expect(byId.get("Inbox.md")).toMatchObject({ in: 0, out: 0, degree: 0, folder: "" });
  });

  test("unresolved link targets become ghost nodes", () => {
    const { nodes } = computeGraphModel(NOTES, LINKS);
    const ghost = nodes.find((n) => n.id === "Missing.md");
    expect(ghost).toMatchObject({ label: "Missing", in: 1, out: 0, degree: 1 });
  });

  test("an explicit folder wins over the derived one", () => {
    const { nodes } = computeGraphModel([{ ...NOTES[0]!, folder: "Custom" }], []);
    expect(nodes[0]!.folder).toBe("Custom");
  });

  test("falls back to the filename stem when title is empty", () => {
    const { nodes } = computeGraphModel([{ path: "Areas/X.md", title: "", linksOut: [] }], []);
    expect(nodes[0]!.label).toBe("X");
  });

  test("returns fresh copies so the simulation cannot mutate caller data", () => {
    const { nodes, links } = computeGraphModel(NOTES, LINKS);
    links[0]!.source = "mutated";
    nodes[0]!.x = 42;
    expect(LINKS[0]!.source).toBe("Areas/Marketing.md");
    expect(NOTES[0]).not.toHaveProperty("x");
  });

  test("seeds distinct finite positions so the pre-physics paint is not stacked at the origin", () => {
    const { nodes } = computeGraphModel(NOTES, LINKS);
    expect(nodes.length).toBeGreaterThan(1);
    const seen = new Set<string>();
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      const key = `${node.x}:${node.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Ghost nodes are seeded too.
    expect(nodes.find((n) => n.id === "Missing.md")?.x).toBeDefined();
  });
});

describe("neighbourSet", () => {
  const edges = computeGraphModel(NOTES, LINKS).links;

  test("null hover means no isolation", () => {
    expect(neighbourSet(null, edges)).toBeNull();
  });

  test("contains the hovered note and everything one hop away", () => {
    expect(neighbourSet("People/Ada.md", edges)).toEqual(
      new Set(["People/Ada.md", "Areas/Marketing.md", "Missing.md"]),
    );
    expect(neighbourSet("Inbox.md", edges)).toEqual(new Set(["Inbox.md"]));
  });
});

describe("noteFolder", () => {
  test("returns the containing folder or empty for root notes", () => {
    expect(noteFolder("Areas/Marketing.md")).toBe("Areas");
    expect(noteFolder("a/b/c.md")).toBe("a/b");
    expect(noteFolder("Inbox.md")).toBe("");
  });
});
