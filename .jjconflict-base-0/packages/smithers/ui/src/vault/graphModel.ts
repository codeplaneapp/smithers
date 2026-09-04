/**
 * Pure graph-model helpers for {@link KnowledgeGraph}, extracted so the math
 * (degree tallying, radius scaling, folder tint assignment, hub-label
 * threshold, hover neighbourhood) is testable without d3-force or a DOM.
 */
import { noteLabel } from "./wikilinks";
import type { VaultLink, VaultNoteMeta } from "./types";

/** A graph node: one vault note plus its link-degree tally and sim position. */
export type VaultGraphNode = {
  id: string;
  label: string;
  folder: string;
  in: number;
  out: number;
  degree: number;
  x?: number;
  y?: number;
};

/** A graph edge. d3-force mutates source/target from id strings into node
 *  references in place, hence the union. */
export type VaultGraphEdge = { source: string | VaultGraphNode; target: string | VaultGraphNode };

/** Stable folder → hue, so the same area keeps its colour between sessions. */
export function folderHue(folder: string): number {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = (Math.imul(hash, 31) + folder.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** Degree-scaled node radius: hubs read as hubs, leaves stay out of the way. */
export function nodeRadius(degree: number): number {
  return 3 + Math.sqrt(degree) * 1.6;
}

/**
 * The house semantic tints node colors rotate through (mapped to
 * `data-tint` attributes; vaultCss paints them with color-mix tints).
 */
export const GRAPH_FOLDER_TINTS = ["brand", "success", "info", "warning"] as const;
export type GraphFolderTint = (typeof GRAPH_FOLDER_TINTS)[number];

/** Deterministic folder → palette slot, stable across sessions. */
export function folderTintIndex(folder: string): number {
  return folderHue(folder) % GRAPH_FOLDER_TINTS.length;
}

export function folderTint(folder: string): GraphFolderTint {
  return GRAPH_FOLDER_TINTS[folderTintIndex(folder)] ?? "brand";
}

/** Only hubs get labels; hundreds of labels at once are unreadable. */
export const HUB_LABEL_MIN_DEGREE = 6;

export function shouldShowLabel(degree: number, threshold: number = HUB_LABEL_MIN_DEGREE): boolean {
  return degree >= threshold;
}

/** Containing folder of a vault path; "" for root-level notes. */
export function noteFolder(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Default SVG viewport the seed layout (and the KnowledgeGraph viewBox) targets. */
export const GRAPH_VIEWPORT_WIDTH = 1200;
export const GRAPH_VIEWPORT_HEIGHT = 720;

/** Golden angle (rad): successive nodes land ~137.5° apart, so the spiral never lines up with itself. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Radial spacing between successive turns of the seed spiral. */
const SEED_SPACING = 36;

/**
 * Seed every node a distinct position on a golden-angle spiral around the
 * viewport center. Without seeds every node starts at (0,0) and the first
 * pre-physics paint is a single stacked pile (edges converging on the
 * origin) before the simulation snaps into layout; the spiral makes the
 * very first frame an honest, readable scatter instead.
 */
function seedGraphPositions(nodes: VaultGraphNode[]): void {
  const cx = GRAPH_VIEWPORT_WIDTH / 2;
  const cy = GRAPH_VIEWPORT_HEIGHT / 2;
  nodes.forEach((node, index) => {
    const radius = SEED_SPACING * Math.sqrt(index + 0.5);
    const angle = index * GOLDEN_ANGLE;
    node.x = cx + radius * Math.cos(angle);
    node.y = cy + radius * Math.sin(angle);
  });
}

/**
 * Build the force-simulation payload from vault data. Nodes/links are fresh
 * copies (d3-force mutates them in place; mutating caller data would corrupt
 * it). Link endpoints with no matching note become ghost nodes, the way
 * Obsidian shows unresolved links.
 */
export function computeGraphModel(
  notes: readonly VaultNoteMeta[],
  links: readonly VaultLink[],
): { nodes: VaultGraphNode[]; links: VaultGraphEdge[] } {
  const tally = new Map<string, { in: number; out: number }>();
  const ensure = (id: string): { in: number; out: number } => {
    let entry = tally.get(id);
    if (!entry) {
      entry = { in: 0, out: 0 };
      tally.set(id, entry);
    }
    return entry;
  };
  for (const note of notes) ensure(note.path);
  for (const link of links) {
    ensure(link.source).out += 1;
    ensure(link.target).in += 1;
  }

  const known = new Set(notes.map((note) => note.path));
  const nodes: VaultGraphNode[] = notes.map((note) => {
    const entry = tally.get(note.path) ?? { in: 0, out: 0 };
    return {
      id: note.path,
      label: note.title || noteLabel(note.path),
      folder: note.folder ?? noteFolder(note.path),
      in: entry.in,
      out: entry.out,
      degree: entry.in + entry.out,
    };
  });
  for (const id of tally.keys()) {
    if (known.has(id)) continue;
    const entry = tally.get(id) ?? { in: 0, out: 0 };
    nodes.push({
      id,
      label: noteLabel(id),
      folder: noteFolder(id),
      in: entry.in,
      out: entry.out,
      degree: entry.in + entry.out,
    });
  }
  seedGraphPositions(nodes);
  return { nodes, links: links.map((link) => ({ source: link.source, target: link.target })) };
}

/**
 * The hovered note plus everything one hop away; `null` when nothing is
 * hovered. Non-members are dimmed to isolate the neighbourhood.
 */
export function neighbourSet(hover: string | null, links: readonly VaultGraphEdge[]): Set<string> | null {
  if (!hover) return null;
  const set = new Set<string>([hover]);
  for (const link of links) {
    const source = typeof link.source === "string" ? link.source : link.source.id;
    const target = typeof link.target === "string" ? link.target : link.target.id;
    if (source === hover) set.add(target);
    if (target === hover) set.add(source);
  }
  return set;
}
