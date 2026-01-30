"""Ralph Loops: Declarative iteration for workflows.

Ralph Loops provide a middle ground between DAGs and complex state machines,
enabling declarative iteration while preserving the DAG model.

A Ralph loop is a **single node** in the DAG that internally iterates.
From the graph's perspective, it's atomic. Internally, it runs a workflow
repeatedly until a condition is met.

Example:
    from smithers import workflow, ralph_loop, claude

    class CodeOutput(BaseModel):
        code: str
        approved: bool = False

    @workflow
    async def review_and_revise(code: CodeOutput) -> CodeOutput:
        review = await claude(f"Review: {code.code}", output=ReviewOutput)
        if review.approved:
            return CodeOutput(code=code.code, approved=True)
        return await claude(f"Fix: {review.feedback}", output=CodeOutput)

    # Loop until approved (max 5 iterations)
    review_loop = ralph_loop(
        review_and_revise,
        until=lambda r: r.approved,
        max_iterations=5,
    )

    # Use in a graph like any other workflow
    graph = build_graph(review_loop)
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any, ParamSpec, TypeVar, get_type_hints

from pydantic import BaseModel

from smithers.types import NO_RETRY, RetryPolicy
from smithers.workflow import Workflow, _extract_dependency_type

P = ParamSpec("P")
T = TypeVar("T", bound=BaseModel)


@dataclass
class RalphLoopConfig:
    """Configuration for a Ralph loop."""

    max_iterations: int = 5
    until_condition: Callable[[Any], bool] | None = None
    until_repr: str = ""  # String representation for visibility
    cacheable: bool = True
    cache_iterations: bool = True  # Whether individual iterations can be cached


@dataclass
class RalphLoopWorkflow(Workflow):
    """A workflow that iterates internally using Ralph loop semantics.

    This extends Workflow to add loop-specific configuration while
    maintaining full compatibility with the graph builder and executor.
    """

    loop_config: RalphLoopConfig = field(default_factory=RalphLoopConfig)
    inner_workflow: Workflow | None = None

    def is_ralph_loop(self) -> bool:
        """Return True to identify this as a Ralph loop."""
        return True


def ralph_loop(
    workflow: Workflow | Callable[..., Coroutine[Any, Any, T]],
    *,
    until: Callable[[T], bool] | None = None,
    max_iterations: int = 5,
    cacheable: bool = True,
    cache_iterations: bool = True,
    retry: RetryPolicy | None = None,
    register: bool = True,
) -> RalphLoopWorkflow:
    """
    Create a Ralph loop from a workflow.

    A Ralph loop wraps a workflow and runs it iteratively until a condition
    is met or max iterations are reached. The loop appears as a single node
    in the DAG while internally iterating.

    Args:
        workflow: The workflow to iterate. Can be a Workflow instance or
                  an async function decorated with @workflow.
        until: Predicate function that receives the workflow output and
               returns True when the loop should stop. If None, the loop
               runs for max_iterations.
        max_iterations: Maximum number of iterations (default: 5).
        cacheable: Whether the overall loop result can be cached (default: True).
        cache_iterations: Whether individual iterations can be cached (default: True).
        retry: Optional retry policy for the loop.
        register: Whether to register in global registry (default: True).

    Returns:
        A RalphLoopWorkflow that can be used like any other workflow.

    Example:
        @workflow
        async def refine(doc: DocOutput) -> DocOutput:
            ...

        # Create a loop that refines until quality > 0.8
        refinement_loop = ralph_loop(
            refine,
            until=lambda doc: doc.quality > 0.8,
            max_iterations=3,
        )

        # Use in graph
        graph = build_graph(refinement_loop)
    """
    # If it's not already a Workflow, assume it's a decorated function
    if not isinstance(workflow, Workflow):
        raise TypeError(
            "ralph_loop requires a Workflow instance. "
            "Make sure to use @workflow decorator on the function."
        )

    # Generate condition representation for visibility
    until_repr = ""
    if until is not None:
        try:
            source = inspect.getsource(until)
            until_repr = source.strip()
        except (OSError, TypeError):
            until_repr = f"<condition at {id(until):#x}>"

    loop_config = RalphLoopConfig(
        max_iterations=max_iterations,
        until_condition=until,
        until_repr=until_repr,
        cacheable=cacheable,
        cache_iterations=cache_iterations,
    )

    # Create the loop wrapper workflow name
    loop_name = f"{workflow.name}_loop"

    # The loop has the same input/output types as the inner workflow
    # This allows it to be used in dependency resolution
    loop_workflow = RalphLoopWorkflow(
        name=loop_name,
        fn=workflow.fn,  # We'll override execution
        output_type=workflow.output_type,
        input_types=workflow.input_types,
        input_is_list=workflow.input_is_list,
        input_optional=workflow.input_optional,
        requires_approval=workflow.requires_approval,
        approval_message=workflow.approval_message,
        approval_context=workflow.approval_context,
        approval_timeout=workflow.approval_timeout,
        output_optional=workflow.output_optional,
        bound_args=workflow.bound_args,
        bound_deps=workflow.bound_deps,
        retry_policy=retry or workflow.retry_policy,
        loop_config=loop_config,
        inner_workflow=workflow,
    )

    # Register the loop workflow if requested
    if register:
        from smithers.workflow import _registry

        if loop_workflow.output_type in _registry:
            existing = _registry[loop_workflow.output_type]
            # Only error if it's a different workflow
            if existing.name != loop_workflow.name:
                raise ValueError(
                    f"Multiple workflows produce {loop_workflow.output_type.__name__}: "
                    f"{existing.name} and {loop_workflow.name}"
                )
        _registry[loop_workflow.output_type] = loop_workflow

    return loop_workflow


def is_ralph_loop(workflow: Workflow) -> bool:
    """Check if a workflow is a Ralph loop."""
    return isinstance(workflow, RalphLoopWorkflow)


async def execute_ralph_loop(
    loop: RalphLoopWorkflow,
    initial_input: BaseModel,
    *,
    run_id: str | None = None,
    node_id: str | None = None,
    store: Any | None = None,
    on_iteration: Callable[[int, BaseModel], Coroutine[Any, Any, None]] | None = None,
) -> tuple[BaseModel, int]:
    """
    Execute a Ralph loop.

    This function handles the iteration logic for Ralph loops, executing
    the inner workflow repeatedly until the termination condition is met
    or max_iterations is reached.

    Args:
        loop: The RalphLoopWorkflow to execute.
        initial_input: The initial input to the loop (first iteration input).
        run_id: Optional run ID for tracking.
        node_id: Optional node ID for tracking.
        store: Optional SqliteStore for persisting iteration events.
        on_iteration: Optional callback called after each iteration.

    Returns:
        Tuple of (final_output, iteration_count).
    """
    config = loop.loop_config
    inner_workflow = loop.inner_workflow

    if inner_workflow is None:
        raise ValueError("RalphLoopWorkflow has no inner_workflow set")

    current = initial_input
    final_iteration = 0

    for iteration in range(config.max_iterations):
        final_iteration = iteration + 1

        # Emit LoopIterationStarted event if store is available
        if store is not None and run_id is not None and node_id is not None:
            from smithers.hashing import hash_json

            input_hash = hash_json(
                current.model_dump() if hasattr(current, "model_dump") else current
            )
            await store.emit_loop_iteration_started(
                run_id=run_id,
                loop_node_id=node_id,
                iteration=iteration,
                input_hash=input_hash,
            )

        # Execute the inner workflow
        # Build kwargs from the current state
        kwargs = {}
        for param_name in inner_workflow.input_types:
            if param_name in inner_workflow.bound_args:
                kwargs[param_name] = inner_workflow.bound_args[param_name]
            else:
                # Pass current as the input
                kwargs[param_name] = current

        result = await inner_workflow(**kwargs)

        # Emit LoopIterationFinished event if store is available
        if store is not None and run_id is not None and node_id is not None:
            from smithers.hashing import hash_json

            output_hash = hash_json(
                result.model_dump() if hasattr(result, "model_dump") else result
            )
            await store.emit_loop_iteration_finished(
                run_id=run_id,
                loop_node_id=node_id,
                iteration=iteration,
                output_hash=output_hash,
            )

        # Call iteration callback if provided
        if on_iteration is not None:
            await on_iteration(iteration, result)

        # Check termination condition
        if config.until_condition is not None and config.until_condition(result):
            return result, final_iteration

        # Prepare for next iteration
        current = result

    # Max iterations reached
    if store is not None and run_id is not None and node_id is not None:
        await store.emit_event(
            run_id,
            node_id,
            "LoopMaxIterationsReached",
            {"max_iterations": config.max_iterations, "final_iteration": final_iteration},
        )

    return current, final_iteration
