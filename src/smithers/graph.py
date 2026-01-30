"""Graph building and execution."""

from typing import Any, TypeVar

from pydantic import BaseModel

from smithers.cache import Cache
from smithers.types import WorkflowGraph, WorkflowNode
from smithers.workflow import Workflow, get_workflow_by_output

T = TypeVar("T", bound=BaseModel)


def build_graph(target: Workflow) -> WorkflowGraph:
    """
    Build an execution graph from a target workflow.

    Walks the dependency tree by inspecting type hints and builds
    a graph with nodes, edges, and parallelization levels.

    Example:
        graph = build_graph(deploy_workflow)
        print(graph.mermaid())
    """
    nodes: dict[str, WorkflowNode] = {}
    edges: list[tuple[str, str]] = []

    def visit(wf: Workflow) -> None:
        """Recursively visit workflow and its dependencies."""
        if wf.name in nodes:
            return

        # Find dependencies
        dep_names: list[str] = []
        for _param_name, param_type in wf.input_types.items():
            dep_wf = get_workflow_by_output(param_type)
            if dep_wf is None:
                raise ValueError(
                    f"Workflow '{wf.name}' depends on {param_type.__name__}, "
                    f"but no workflow produces that type"
                )
            visit(dep_wf)
            dep_names.append(dep_wf.name)
            edges.append((dep_wf.name, wf.name))

        # Create node
        nodes[wf.name] = WorkflowNode(
            name=wf.name,
            output_type=wf.output_type,
            dependencies=dep_names,
            requires_approval=wf.requires_approval,
            approval_message=wf.approval_message,
        )

    visit(target)

    # Compute levels (topological sort with parallelization)
    levels = _compute_levels(nodes)

    return WorkflowGraph(
        root=target.name,
        nodes=nodes,
        edges=edges,
        levels=levels,
    )


def _compute_levels(nodes: dict[str, WorkflowNode]) -> list[list[str]]:
    """
    Compute execution levels for parallel execution.

    Nodes in the same level can run in parallel.
    """
    # Compute in-degrees
    in_degree: dict[str, int] = {name: 0 for name in nodes}
    for node in nodes.values():
        for dep in node.dependencies:
            if dep in in_degree:
                pass  # dep -> node edge
        in_degree[node.name] = len(node.dependencies)

    levels: list[list[str]] = []
    remaining = set(nodes.keys())

    while remaining:
        # Find all nodes with no remaining dependencies
        level = [name for name in remaining if in_degree[name] == 0]
        if not level:
            # Circular dependency
            raise ValueError(f"Circular dependency detected among: {remaining}")

        levels.append(sorted(level))

        # Remove this level and update in-degrees
        for name in level:
            remaining.remove(name)
            # Decrease in-degree of nodes that depend on this one
            for node in nodes.values():
                if name in node.dependencies:
                    in_degree[node.name] -= 1

    return levels


async def run_graph(
    graph: WorkflowGraph,
    cache: Cache | None = None,
    max_concurrency: int | None = None,
) -> Any:
    """
    Execute a workflow graph.

    Runs workflows level by level, with workflows in the same level
    executing in parallel.

    Args:
        graph: The workflow graph to execute
        cache: Optional cache for skipping unchanged workflows
        max_concurrency: Maximum number of concurrent workflows (default: unlimited)

    Returns:
        The output of the root workflow
    """
    # TODO: Implement execution engine
    # This is a placeholder that will be replaced with the real implementation
    raise NotImplementedError("run_graph is not yet implemented")
