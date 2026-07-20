import type { RunNode } from "./Run";
import { statusLabel, statusTone } from "./statusMeta";

/** One row in the run tree: indent + chevron/leaf + name + mono state tag. */
export function RunTreeRow({
  node,
  depth,
  selected,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: RunNode;
  depth: number;
  selected: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  return (
    <button
      type="button"
      className={selected ? "tree-row is-selected" : "tree-row"}
      style={{ paddingLeft: 8 + depth * 16 }}
      data-testid={`tree-row-${node.id}`}
      onClick={onSelect}
    >
      <span
        className="tree-chev"
        onClick={(event) => {
          if (hasChildren) {
            event.stopPropagation();
            onToggle();
          }
        }}
      >
        {hasChildren ? (collapsed ? "▸" : "▾") : "·"}
      </span>
      <span className="tree-name">{node.name}</span>
      <span className={`tree-tag tone-${statusTone(node.status)}`}>
        {node.meta && node.meta !== statusLabel(node.status)
          ? node.meta
          : statusLabel(node.status)}
      </span>
    </button>
  );
}
