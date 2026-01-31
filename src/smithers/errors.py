"""Custom error types for Smithers."""

from __future__ import annotations

import json
from typing import Any


class SmithersError(Exception):
    """Base exception for Smithers errors."""


class WorkflowError(SmithersError):
    """Raised when one or more workflows fail during execution."""

    def __init__(
        self,
        workflow_name: str,
        cause: BaseException,
        *,
        completed: list[str] | None = None,
        errors: dict[str, BaseException] | None = None,
    ) -> None:
        super().__init__(str(cause))
        self.workflow_name = workflow_name
        self.cause = cause
        self.completed = completed or []
        self.errors = errors or {}


class ApprovalRejected(SmithersError):
    """Raised when a required approval is rejected."""

    def __init__(self, workflow_name: str, reason: str | None = None) -> None:
        message = reason or "Approval rejected"
        super().__init__(message)
        self.workflow_name = workflow_name
        self.reason = reason


class ClaudeError(SmithersError):
    """Raised when the Claude API returns an error."""

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class RateLimitError(ClaudeError):
    """Raised when the Claude API rate limits the request."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after: float | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, cause=cause)
        self.retry_after = retry_after


class ToolError(SmithersError):
    """Raised when tool execution fails."""

    def __init__(self, tool_name: str, message: str, *, data: Any | None = None) -> None:
        super().__init__(message)
        self.tool_name = tool_name
        self.data = data


class SmithersTimeoutError(SmithersError):
    """Base class for timeout-related errors.

    This is named SmithersTimeoutError to avoid shadowing the built-in
    Python TimeoutError exception.
    """


class WorkflowTimeoutError(SmithersTimeoutError):
    """
    Raised when a workflow exceeds its timeout limit.

    Attributes:
        workflow_name: Name of the workflow that timed out
        timeout_seconds: The configured timeout in seconds
        elapsed_seconds: Actual time elapsed before timeout
    """

    def __init__(
        self,
        workflow_name: str,
        timeout_seconds: float,
        elapsed_seconds: float,
    ) -> None:
        self.workflow_name = workflow_name
        self.timeout_seconds = timeout_seconds
        self.elapsed_seconds = elapsed_seconds
        super().__init__(
            f"Workflow '{workflow_name}' timed out after {elapsed_seconds:.2f}s "
            f"(limit: {timeout_seconds:.2f}s)"
        )


class GraphTimeoutError(SmithersTimeoutError):
    """
    Raised when graph execution exceeds its global timeout.

    Attributes:
        timeout_seconds: The configured global timeout in seconds
        elapsed_seconds: Actual time elapsed
        completed_nodes: List of nodes that completed before timeout
        running_nodes: List of nodes that were running when timeout occurred
    """

    def __init__(
        self,
        timeout_seconds: float,
        elapsed_seconds: float,
        completed_nodes: list[str] | None = None,
        running_nodes: list[str] | None = None,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.elapsed_seconds = elapsed_seconds
        self.completed_nodes = completed_nodes or []
        self.running_nodes = running_nodes or []
        super().__init__(
            f"Graph execution timed out after {elapsed_seconds:.2f}s "
            f"(limit: {timeout_seconds:.2f}s). "
            f"Completed: {len(self.completed_nodes)}, Running: {len(self.running_nodes)}"
        )


def serialize_error(error: BaseException, *, max_depth: int = 3) -> dict[str, Any]:
    """Serialize an exception to a JSON-safe dict."""
    return _serialize_error(error, max_depth=max_depth, seen=set())


def _serialize_error(
    error: BaseException,
    *,
    max_depth: int,
    seen: set[int],
) -> dict[str, Any]:
    message = str(error)
    if not message:
        message = repr(error)

    payload: dict[str, Any] = {"type": type(error).__name__, "message": message}

    if id(error) in seen:
        payload["note"] = "cycle"
        return payload

    seen.add(id(error))

    if isinstance(error, WorkflowError):
        payload["workflow_name"] = error.workflow_name
        if error.completed:
            payload["completed"] = list(error.completed)
        if error.errors:
            payload["errors"] = {
                name: _serialize_error(err, max_depth=max_depth - 1, seen=seen)
                if max_depth > 0
                else {"type": type(err).__name__, "message": str(err) or repr(err)}
                for name, err in error.errors.items()
            }
    elif isinstance(error, ApprovalRejected):
        payload["workflow_name"] = error.workflow_name
        if error.reason is not None:
            payload["reason"] = error.reason
    elif isinstance(error, RateLimitError):
        if error.retry_after is not None:
            payload["retry_after"] = error.retry_after
    elif isinstance(error, ToolError):
        payload["tool_name"] = error.tool_name
        if error.data is not None:
            payload["data"] = _safe_value(error.data)
    elif isinstance(error, WorkflowTimeoutError):
        payload["workflow_name"] = error.workflow_name
        payload["timeout_seconds"] = error.timeout_seconds
        payload["elapsed_seconds"] = error.elapsed_seconds
    elif isinstance(error, GraphTimeoutError):
        payload["timeout_seconds"] = error.timeout_seconds
        payload["elapsed_seconds"] = error.elapsed_seconds
        if error.completed_nodes:
            payload["completed_nodes"] = list(error.completed_nodes)
        if error.running_nodes:
            payload["running_nodes"] = list(error.running_nodes)

    if max_depth > 0:
        cause = error.__cause__ or (
            error.__context__ if not getattr(error, "__suppress_context__", False) else None
        )
        if cause is not None:
            payload["cause"] = _serialize_error(
                cause,
                max_depth=max_depth - 1,
                seen=seen,
            )

    return payload


def _safe_value(value: Any) -> Any:
    try:
        json.dumps(value)
    except TypeError:
        return repr(value)
    return value
