import { useCardUiStore } from "../cards/cardUiStore";
import type { RunNode } from "./Run";
import { RunTreeRow } from "./RunTreeRow";

/** Flatten the tree into rows, honoring the collapsed set. */
function rows(
  node: RunNode,
  depth: number,
  collapsed: Set<string>,
): Array<{ node: RunNode; depth: number }> {
  const here = [{ node, depth }];
  if (collapsed.has(node.id)) {
    return here;
  }
  return here.concat(
    (node.children ?? []).flatMap((child) => rows(child, depth + 1, collapsed)),
  );
}

/** The run's node tree with expand/collapse and a single selected node. The
 *  collapsed set lives in the consolidated card-UI store. */
export function RunTree({
  root,
  selectedId,
  onSelect,
}: {
  root: RunNode;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const collapsedIds = useCardUiStore((state) => state.inspectorCollapsed);
  const toggleCollapsed = useCardUiStore((state) => state.toggleCollapsed);
  const collapsed = new Set(collapsedIds);

  return (
    <div className="run-tree">
      {rows(root, 0, collapsed).map(({ node, depth }) => (
        <RunTreeRow
          key={node.id}
          node={node}
          depth={depth}
          selected={node.id === selectedId}
          collapsed={collapsed.has(node.id)}
          onToggle={() => toggleCollapsed(node.id)}
          onSelect={() => onSelect(node.id)}
        />
      ))}
    </div>
  );
}
