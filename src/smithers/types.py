"""Core types for Smithers."""

from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@dataclass
class WorkflowNode:
    """A node in the workflow graph."""

    name: str
    output_type: type[BaseModel]
    dependencies: list[str] = field(default_factory=list)
    requires_approval: bool = False
    approval_message: str | None = None


@dataclass
class WorkflowGraph:
    """A complete workflow execution graph."""

    root: str
    nodes: dict[str, WorkflowNode] = field(default_factory=dict)
    edges: list[tuple[str, str]] = field(default_factory=list)
    levels: list[list[str]] = field(default_factory=list)

    def mermaid(self) -> str:
        """Generate a Mermaid diagram of the graph."""
        lines = ["graph LR"]
        for from_node, to_node in self.edges:
            lines.append(f"    {from_node} --> {to_node}")
        return "\n".join(lines)


@dataclass
class WorkflowResult:
    """Result of a workflow execution."""

    name: str
    output: Any
    cached: bool = False
    duration_ms: float = 0.0


@dataclass
class CacheStats:
    """Statistics about cache usage."""

    entries: int = 0
    hits: int = 0
    misses: int = 0
    size_bytes: int = 0
