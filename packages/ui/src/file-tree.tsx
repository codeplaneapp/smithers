/** @jsxImportSource react */
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

/** One entry in the flat list a {@link FileTree} groups into a nested tree. */
export type FileTreeNode = {
  /** Full `/`-delimited path; determines nesting and identity. */
  path: string;
  /** Leaf label; defaults to the last path segment. */
  label?: ReactNode;
};

/** A node accepted by {@link FileTree}: a full `FileTreeNode` or a bare path string. */
export type FileTreeItem = FileTreeNode | string;

export type FileTreeProps = Omit<ComponentProps<"div">, "onSelect"> & {
  /** Flat list of paths (or nodes) grouped into a nested tree by `/`. */
  nodes: ReadonlyArray<FileTreeItem>;
  /** Controlled selected path; the matching leaf gets the active treatment. */
  selected?: string | null;
  /** Fired with the node path when a leaf is activated. */
  onSelect?: (path: string) => void;
  /** Optional trailing affordance rendered beside each leaf (dirty dot, menu, badge). */
  renderAffordance?: (node: FileTreeNode) => ReactNode;
  /*
   * Pass-through attributes for the leaf row buttons this component renders on
   * the host's behalf.
   *
   * A host whose affordances must name the act behind them — a `data-flow`
   * binding, an analytics id, a test hook — otherwise has to reach into this
   * component's rendered DOM from outside, which is the exact coupling a
   * pass-through prop exists to prevent (LIBRARY-CHANGE-REQUESTS §3).
   */
  nodeProps?: (node: FileTreeNode) => ComponentProps<"button">;
  /** Start with every directory collapsed (default: expanded). */
  defaultCollapsed?: boolean;
};

type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: FileTreeNode[] };

function toNode(item: FileTreeItem): FileTreeNode {
  return typeof item === "string" ? { path: item } : item;
}

/** Group flat `/`-delimited paths into a nested directory tree. */
function buildTree(nodes: ReadonlyArray<FileTreeNode>): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const node of nodes) {
    const parts = node.path.split("/").filter(Boolean);
    let dir = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      let next = dir.dirs.find((child) => child.name === name);
      if (!next) {
        next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(node);
  }
  return root;
}

/** Every directory path in the tree, for seeding the default-collapsed state. */
function directoryPaths(dir: TreeDir, out: string[] = []): string[] {
  for (const child of dir.dirs) {
    out.push(child.path);
    directoryPaths(child, out);
  }
  return out;
}

function leafLabel(node: FileTreeNode): ReactNode {
  if (node.label !== undefined) return node.label;
  return node.path.split("/").filter(Boolean).at(-1) ?? node.path;
}

function FileTreeLevel({
  dir,
  selected,
  collapsed,
  onToggle,
  onSelect,
  renderAffordance,
  nodeProps,
}: {
  dir: TreeDir;
  selected: string | null | undefined;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect?: (path: string) => void;
  renderAffordance?: (node: FileTreeNode) => ReactNode;
  nodeProps?: (node: FileTreeNode) => ComponentProps<"button">;
}) {
  return (
    <>
      {dir.dirs.map((child) => {
        const isCollapsed = collapsed.has(child.path);
        return (
          <div className="sui-file-tree-dir" data-slot="file-tree-dir" key={`dir:${child.path}`}>
            <button
              type="button"
              className="sui-file-tree-dir-toggle"
              data-slot="file-tree-dir-toggle"
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(child.path)}
            >
              <span className="sui-file-tree-caret" aria-hidden="true" />
              <span className="sui-file-tree-dir-name">{child.name}</span>
            </button>
            {isCollapsed ? null : (
              <div className="sui-file-tree-children">
                <FileTreeLevel
                  dir={child}
                  selected={selected}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  renderAffordance={renderAffordance}
                  nodeProps={nodeProps}
                />
              </div>
            )}
          </div>
        );
      })}
      {dir.files.map((node) => {
        const active = node.path === selected;
        const affordance = renderAffordance?.(node);
        return (
          <div className="sui-file-tree-row" data-slot="file-tree-row" key={`file:${node.path}`}>
            <button
              type="button"
              className="sui-file-tree-file"
              data-slot="file-tree-file"
              data-active={active ? "true" : undefined}
              title={node.path}
              onClick={() => onSelect?.(node.path)}
              {...nodeProps?.(node)}
            >
              <span className="sui-file-tree-file-name">{leafLabel(node)}</span>
            </button>
            {affordance != null && affordance !== false ? (
              <span className="sui-file-tree-affordance" data-slot="file-tree-affordance">
                {affordance}
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * Generic collapsible file/path tree. Groups a flat list of `/`-delimited paths
 * into nested directories with expand/collapse, controlled single selection
 * (`selected` + `onSelect`), and an optional per-leaf trailing affordance slot.
 * Zero app/store/router coupling — every behavior is driven by props.
 */
export function FileTree({
  nodes,
  selected,
  onSelect,
  renderAffordance,
  nodeProps,
  defaultCollapsed = false,
  className,
  ...props
}: FileTreeProps) {
  useInjectUiCss();
  const resolved = nodes.map(toNode);
  const root = buildTree(resolved);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    defaultCollapsed ? new Set(directoryPaths(root)) : new Set(),
  );
  const onToggle = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return (
    <div data-slot="file-tree" className={cn("sui-file-tree", className)} {...props}>
      <FileTreeLevel
        dir={root}
        selected={selected}
        collapsed={collapsed}
        onToggle={onToggle}
        onSelect={onSelect}
        renderAffordance={renderAffordance}
        nodeProps={nodeProps}
      />
    </div>
  );
}
