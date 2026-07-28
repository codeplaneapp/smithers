/**
 * The backend-agnostic vault contract. Components in this lane render whatever
 * a `VaultAdapter` serves — an Obsidian directory, a gateway extension, a git
 * repo of markdown — without knowing which.
 */

/** One note in the vault, as metadata (no body content). */
export type VaultNoteMeta = {
  /** Vault-relative path, e.g. "Areas/Marketing.md". The graph node id. */
  path: string;
  /** Display title (usually the filename stem or a frontmatter title). */
  title: string;
  /** Containing folder, e.g. "Areas". Derived from `path` when omitted. */
  folder?: string;
  /** Paths this note links to. */
  linksOut: string[];
  /** Paths that link to this note. */
  backlinks?: string[];
  /** Last-modified time in ms, for autosave conflict detection. */
  mtimeMs?: number;
  /** Parsed YAML frontmatter, when the adapter provides it. */
  frontmatter?: Record<string, unknown>;
};

/** One directed edge in the vault link graph. */
export type VaultLink = {
  /** Source note path. */
  source: string;
  /** Target note path. */
  target: string;
  /** `[[link]]` vs `![[embed]]`; plain link when omitted. */
  kind?: "link" | "embed";
};

/**
 * The adapter contract a vault backend implements. `links` and `graph` are
 * optional: adapters that cannot answer link queries cheaply leave them off
 * and the corresponding panes stay empty.
 */
export interface VaultAdapter {
  /** List every note in the vault. */
  tree(): Promise<VaultNoteMeta[]>;
  /** Read one note's full markdown source (frontmatter included). */
  read(path: string): Promise<string>;
  /** Write one note's full markdown source; returns the new mtime when known. */
  write(path: string, content: string): Promise<{ mtimeMs?: number }>;
  /** Backlinks + outgoing links for one note. */
  links?(path: string): Promise<{ backlinks: string[]; linksOut: string[] }>;
  /** The whole link graph in one shot (the KnowledgeGraph payload). */
  graph?(): Promise<{ notes: VaultNoteMeta[]; links: VaultLink[] }>;
}
