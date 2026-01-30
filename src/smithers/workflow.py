"""Workflow decorator and utilities."""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from functools import wraps
from typing import Any, ParamSpec, TypeVar

from pydantic import BaseModel

P = ParamSpec("P")
T = TypeVar("T", bound=BaseModel)


@dataclass
class SkipResult:
    """Marker indicating a workflow should be skipped."""

    reason: str


def skip(reason: str) -> SkipResult:
    """Skip a workflow with a reason."""
    return SkipResult(reason=reason)


@dataclass
class Workflow:
    """A registered workflow."""

    name: str
    fn: Callable[..., Coroutine[Any, Any, BaseModel]]
    output_type: type[BaseModel]
    input_types: dict[str, type[BaseModel]]
    requires_approval: bool = False
    approval_message: str | None = None

    async def __call__(self, *args: Any, **kwargs: Any) -> BaseModel:
        """Execute the workflow function."""
        return await self.fn(*args, **kwargs)


# Global registry of workflows by output type
_registry: dict[type[BaseModel], Workflow] = {}


def get_workflow_by_output(output_type: type[BaseModel]) -> Workflow | None:
    """Get a workflow by its output type."""
    return _registry.get(output_type)


def get_all_workflows() -> dict[type[BaseModel], Workflow]:
    """Get all registered workflows."""
    return _registry.copy()


def clear_registry() -> None:
    """Clear the workflow registry (mainly for testing)."""
    _registry.clear()


def workflow(fn: Callable[P, Coroutine[Any, Any, T]]) -> Workflow:
    """
    Decorator to register a function as a workflow.

    Example:
        @workflow
        async def analyze() -> AnalysisOutput:
            return await claude("Analyze", output=AnalysisOutput)
    """
    # Get type hints
    hints = fn.__annotations__
    return_type = hints.get("return")

    if return_type is None:
        raise TypeError(f"Workflow {fn.__name__} must have a return type annotation")

    # Extract input types (Pydantic models from parameters)
    input_types: dict[str, type[BaseModel]] = {}
    for param_name, param_type in hints.items():
        if param_name == "return":
            continue
        if isinstance(param_type, type) and issubclass(param_type, BaseModel):
            input_types[param_name] = param_type

    # Create workflow object
    wf = Workflow(
        name=fn.__name__,
        fn=fn,
        output_type=return_type,
        input_types=input_types,
    )

    # Register in global registry
    if return_type in _registry:
        existing = _registry[return_type]
        raise ValueError(
            f"Multiple workflows produce {return_type.__name__}: {existing.name} and {fn.__name__}"
        )
    _registry[return_type] = wf

    return wf


def require_approval(
    message: str,
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to require human approval before executing a workflow.

    Example:
        @workflow
        @require_approval("Deploy to production?")
        async def deploy() -> DeployOutput:
            ...
    """

    def decorator(fn: Callable[P, Coroutine[Any, Any, T]]) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            # Approval logic will be handled by the executor
            return await fn(*args, **kwargs)

        # Mark the function as requiring approval
        wrapper._requires_approval = True  # type: ignore[attr-defined]
        wrapper._approval_message = message  # type: ignore[attr-defined]
        return wrapper

    return decorator
