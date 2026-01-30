"""
Smithers: Build AI agent workflows the way you build software.

Smithers is a Python framework for composing LLM agents into type-safe,
cacheable, parallel workflows.
"""

from smithers.cache import SqliteCache
from smithers.claude import claude
from smithers.graph import build_graph, run_graph
from smithers.types import WorkflowGraph
from smithers.workflow import require_approval, skip, workflow

__version__ = "0.1.0"

__all__ = [
    "SqliteCache",
    "WorkflowGraph",
    "__version__",
    "build_graph",
    "claude",
    "require_approval",
    "run_graph",
    "skip",
    "workflow",
]
