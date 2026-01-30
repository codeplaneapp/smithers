"""Tests for custom error types in Smithers."""

from __future__ import annotations

import pytest

from smithers.errors import (
    ApprovalRejected,
    ClaudeError,
    GraphTimeoutError,
    RateLimitError,
    SmithersError,
    TimeoutError,
    ToolError,
    WorkflowError,
    WorkflowTimeoutError,
)

# ============================================================================
# SmithersError Tests
# ============================================================================


class TestSmithersError:
    """Tests for base SmithersError class."""

    def test_basic_creation(self) -> None:
        """Test creating a basic SmithersError."""
        error = SmithersError("Something went wrong")
        assert str(error) == "Something went wrong"

    def test_is_exception(self) -> None:
        """Test that SmithersError is an Exception."""
        error = SmithersError("test")
        assert isinstance(error, Exception)

    def test_can_be_raised(self) -> None:
        """Test that SmithersError can be raised and caught."""
        with pytest.raises(SmithersError, match="test message"):
            raise SmithersError("test message")

    def test_empty_message(self) -> None:
        """Test SmithersError with empty message."""
        error = SmithersError("")
        assert str(error) == ""

    def test_subclass_hierarchy(self) -> None:
        """Test that all Smithers errors inherit from SmithersError."""
        assert issubclass(WorkflowError, SmithersError)
        assert issubclass(ApprovalRejected, SmithersError)
        assert issubclass(ClaudeError, SmithersError)
        assert issubclass(RateLimitError, SmithersError)
        assert issubclass(ToolError, SmithersError)
        assert issubclass(TimeoutError, SmithersError)


# ============================================================================
# WorkflowError Tests
# ============================================================================


class TestWorkflowError:
    """Tests for WorkflowError class."""

    def test_basic_creation(self) -> None:
        """Test creating a WorkflowError with required arguments."""
        cause = ValueError("inner error")
        error = WorkflowError("my_workflow", cause)

        assert error.workflow_name == "my_workflow"
        assert error.cause is cause
        assert error.completed == []
        assert error.errors == {}
        assert str(error) == "inner error"

    def test_with_completed_workflows(self) -> None:
        """Test WorkflowError with completed workflows list."""
        cause = RuntimeError("failed")
        error = WorkflowError(
            "failing_workflow",
            cause,
            completed=["workflow_a", "workflow_b"],
        )

        assert error.completed == ["workflow_a", "workflow_b"]
        assert len(error.completed) == 2

    def test_with_errors_dict(self) -> None:
        """Test WorkflowError with multiple workflow errors."""
        main_cause = RuntimeError("main failure")
        other_error = ValueError("other failure")
        error = WorkflowError(
            "main_workflow",
            main_cause,
            errors={"other_workflow": other_error},
        )

        assert "other_workflow" in error.errors
        assert error.errors["other_workflow"] is other_error

    def test_with_all_arguments(self) -> None:
        """Test WorkflowError with all optional arguments."""
        cause = RuntimeError("test")
        error = WorkflowError(
            "my_workflow",
            cause,
            completed=["a", "b", "c"],
            errors={"d": ValueError("d failed")},
        )

        assert error.workflow_name == "my_workflow"
        assert len(error.completed) == 3
        assert "d" in error.errors

    def test_message_from_cause(self) -> None:
        """Test that message is derived from cause."""
        cause = Exception("This is the cause message")
        error = WorkflowError("workflow", cause)
        assert str(error) == "This is the cause message"

    def test_can_be_raised_and_caught(self) -> None:
        """Test raising and catching WorkflowError."""
        with pytest.raises(WorkflowError) as exc_info:
            raise WorkflowError("test_wf", ValueError("cause"))

        assert exc_info.value.workflow_name == "test_wf"

    def test_catch_as_smithers_error(self) -> None:
        """Test that WorkflowError can be caught as SmithersError."""
        with pytest.raises(SmithersError):
            raise WorkflowError("test", RuntimeError("test"))


# ============================================================================
# ApprovalRejected Tests
# ============================================================================


class TestApprovalRejected:
    """Tests for ApprovalRejected class."""

    def test_basic_creation(self) -> None:
        """Test creating ApprovalRejected with minimal arguments."""
        error = ApprovalRejected("my_workflow")

        assert error.workflow_name == "my_workflow"
        assert error.reason is None
        assert str(error) == "Approval rejected"

    def test_with_reason(self) -> None:
        """Test ApprovalRejected with custom reason."""
        error = ApprovalRejected("deploy_workflow", reason="User clicked deny")

        assert error.workflow_name == "deploy_workflow"
        assert error.reason == "User clicked deny"
        assert str(error) == "User clicked deny"

    def test_empty_reason(self) -> None:
        """Test ApprovalRejected with empty string reason."""
        error = ApprovalRejected("workflow", reason="")

        # Empty string is falsy, so default message is used
        assert str(error) == "Approval rejected"
        assert error.reason == ""

    def test_can_be_raised(self) -> None:
        """Test raising ApprovalRejected."""
        with pytest.raises(ApprovalRejected, match="Approval rejected"):
            raise ApprovalRejected("workflow")

    def test_match_custom_reason(self) -> None:
        """Test matching custom reason in raised error."""
        with pytest.raises(ApprovalRejected, match="Not authorized"):
            raise ApprovalRejected("workflow", reason="Not authorized")


# ============================================================================
# ClaudeError Tests
# ============================================================================


class TestClaudeError:
    """Tests for ClaudeError class."""

    def test_basic_creation(self) -> None:
        """Test creating ClaudeError with message only."""
        error = ClaudeError("API request failed")

        assert str(error) == "API request failed"
        assert error.cause is None

    def test_with_cause(self) -> None:
        """Test ClaudeError with underlying cause."""
        cause = ConnectionError("Network unreachable")
        error = ClaudeError("API request failed", cause=cause)

        assert error.cause is cause
        assert str(error) == "API request failed"

    def test_can_be_raised(self) -> None:
        """Test raising ClaudeError."""
        with pytest.raises(ClaudeError, match="API error"):
            raise ClaudeError("API error")

    def test_inherits_from_smithers_error(self) -> None:
        """Test that ClaudeError is a SmithersError."""
        error = ClaudeError("test")
        assert isinstance(error, SmithersError)


# ============================================================================
# RateLimitError Tests
# ============================================================================


class TestRateLimitError:
    """Tests for RateLimitError class."""

    def test_default_creation(self) -> None:
        """Test creating RateLimitError with defaults."""
        error = RateLimitError()

        assert str(error) == "Rate limit exceeded"
        assert error.retry_after is None
        assert error.cause is None

    def test_with_custom_message(self) -> None:
        """Test RateLimitError with custom message."""
        error = RateLimitError("Too many requests")
        assert str(error) == "Too many requests"

    def test_with_retry_after(self) -> None:
        """Test RateLimitError with retry_after value."""
        error = RateLimitError(retry_after=30.0)

        assert error.retry_after == 30.0
        assert str(error) == "Rate limit exceeded"

    def test_with_cause(self) -> None:
        """Test RateLimitError with underlying cause."""
        cause = Exception("HTTP 429")
        error = RateLimitError("Rate limited", cause=cause)

        assert error.cause is cause

    def test_with_all_arguments(self) -> None:
        """Test RateLimitError with all arguments."""
        cause = Exception("HTTP 429")
        error = RateLimitError(
            "Custom rate limit message",
            retry_after=60.5,
            cause=cause,
        )

        assert str(error) == "Custom rate limit message"
        assert error.retry_after == 60.5
        assert error.cause is cause

    def test_inherits_from_claude_error(self) -> None:
        """Test that RateLimitError is a ClaudeError."""
        error = RateLimitError()
        assert isinstance(error, ClaudeError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising RateLimitError."""
        with pytest.raises(RateLimitError):
            raise RateLimitError(retry_after=10.0)

    def test_catch_as_claude_error(self) -> None:
        """Test that RateLimitError can be caught as ClaudeError."""
        with pytest.raises(ClaudeError):
            raise RateLimitError()


# ============================================================================
# ToolError Tests
# ============================================================================


class TestToolError:
    """Tests for ToolError class."""

    def test_basic_creation(self) -> None:
        """Test creating ToolError with required arguments."""
        error = ToolError("read_file", "File not found")

        assert error.tool_name == "read_file"
        assert str(error) == "File not found"
        assert error.data is None

    def test_with_data(self) -> None:
        """Test ToolError with additional data."""
        data = {"path": "/nonexistent", "attempted": True}
        error = ToolError("read_file", "File not found", data=data)

        assert error.data == data
        assert error.data is not None
        assert error.data["path"] == "/nonexistent"

    def test_with_none_data(self) -> None:
        """Test ToolError with explicit None data."""
        error = ToolError("tool", "error", data=None)
        assert error.data is None

    def test_with_complex_data(self) -> None:
        """Test ToolError with complex data structure."""
        context_list = ["attempt1", "attempt2"]
        data = {
            "command": "ls -la",
            "exit_code": 1,
            "stderr": "Permission denied",
            "context": context_list,
        }
        error = ToolError("bash", "Command failed", data=data)

        assert error.data is not None
        assert error.data["exit_code"] == 1
        assert error.data["context"] == context_list
        assert len(context_list) == 2

    def test_can_be_raised(self) -> None:
        """Test raising ToolError."""
        with pytest.raises(ToolError, match="Permission denied"):
            raise ToolError("edit_file", "Permission denied")

    def test_inherits_from_smithers_error(self) -> None:
        """Test that ToolError is a SmithersError."""
        error = ToolError("tool", "error")
        assert isinstance(error, SmithersError)


# ============================================================================
# TimeoutError Tests
# ============================================================================


class TestTimeoutError:
    """Tests for base TimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating TimeoutError."""
        error = TimeoutError("Operation timed out")
        assert str(error) == "Operation timed out"

    def test_is_smithers_error(self) -> None:
        """Test that TimeoutError is a SmithersError."""
        error = TimeoutError("timeout")
        assert isinstance(error, SmithersError)

    def test_subclass_hierarchy(self) -> None:
        """Test that timeout subclasses inherit from TimeoutError."""
        assert issubclass(WorkflowTimeoutError, TimeoutError)
        assert issubclass(GraphTimeoutError, TimeoutError)


# ============================================================================
# WorkflowTimeoutError Tests
# ============================================================================


class TestWorkflowTimeoutError:
    """Tests for WorkflowTimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating WorkflowTimeoutError."""
        error = WorkflowTimeoutError(
            workflow_name="slow_workflow",
            timeout_seconds=30.0,
            elapsed_seconds=35.5,
        )

        assert error.workflow_name == "slow_workflow"
        assert error.timeout_seconds == 30.0
        assert error.elapsed_seconds == 35.5

    def test_message_format(self) -> None:
        """Test the error message format."""
        error = WorkflowTimeoutError(
            workflow_name="my_wf",
            timeout_seconds=10.0,
            elapsed_seconds=15.25,
        )

        message = str(error)
        assert "my_wf" in message
        assert "15.25" in message
        assert "10.00" in message

    def test_inheritance(self) -> None:
        """Test inheritance chain."""
        error = WorkflowTimeoutError("wf", 1.0, 2.0)
        assert isinstance(error, TimeoutError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising WorkflowTimeoutError."""
        with pytest.raises(WorkflowTimeoutError) as exc_info:
            raise WorkflowTimeoutError("test_wf", 5.0, 10.0)

        assert exc_info.value.workflow_name == "test_wf"


# ============================================================================
# GraphTimeoutError Tests
# ============================================================================


class TestGraphTimeoutError:
    """Tests for GraphTimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating GraphTimeoutError with minimal arguments."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.0,
        )

        assert error.timeout_seconds == 60.0
        assert error.elapsed_seconds == 65.0
        assert error.completed_nodes == []
        assert error.running_nodes == []

    def test_with_completed_nodes(self) -> None:
        """Test GraphTimeoutError with completed nodes."""
        error = GraphTimeoutError(
            timeout_seconds=30.0,
            elapsed_seconds=35.0,
            completed_nodes=["node_a", "node_b"],
        )

        assert error.completed_nodes == ["node_a", "node_b"]
        assert len(error.completed_nodes) == 2

    def test_with_running_nodes(self) -> None:
        """Test GraphTimeoutError with running nodes."""
        error = GraphTimeoutError(
            timeout_seconds=30.0,
            elapsed_seconds=35.0,
            running_nodes=["node_c", "node_d"],
        )

        assert error.running_nodes == ["node_c", "node_d"]
        assert len(error.running_nodes) == 2

    def test_with_all_arguments(self) -> None:
        """Test GraphTimeoutError with all arguments."""
        error = GraphTimeoutError(
            timeout_seconds=120.0,
            elapsed_seconds=125.5,
            completed_nodes=["a", "b", "c"],
            running_nodes=["d", "e"],
        )

        assert error.timeout_seconds == 120.0
        assert error.elapsed_seconds == 125.5
        assert len(error.completed_nodes) == 3
        assert len(error.running_nodes) == 2

    def test_message_format(self) -> None:
        """Test the error message format."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.5,
            completed_nodes=["a", "b"],
            running_nodes=["c"],
        )

        message = str(error)
        assert "65.50" in message
        assert "60.00" in message
        assert "Completed: 2" in message
        assert "Running: 1" in message

    def test_inheritance(self) -> None:
        """Test inheritance chain."""
        error = GraphTimeoutError(1.0, 2.0)
        assert isinstance(error, TimeoutError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising GraphTimeoutError."""
        with pytest.raises(GraphTimeoutError) as exc_info:
            raise GraphTimeoutError(10.0, 15.0, completed_nodes=["x"])

        assert exc_info.value.completed_nodes == ["x"]


# ============================================================================
# Error Chaining Tests
# ============================================================================


class TestErrorChaining:
    """Tests for error chaining scenarios."""

    def test_workflow_error_with_nested_cause(self) -> None:
        """Test WorkflowError with deeply nested cause."""
        root_cause = OSError("Disk full")
        middle_cause = RuntimeError("Could not write cache")
        middle_cause.__cause__ = root_cause

        error = WorkflowError("cache_workflow", middle_cause)

        assert error.cause is middle_cause
        assert error.cause.__cause__ is root_cause

    def test_rate_limit_error_chain(self) -> None:
        """Test RateLimitError with HTTP error as cause."""
        http_error = Exception("HTTP 429 Too Many Requests")
        error = RateLimitError(
            "API rate limit hit",
            retry_after=30.0,
            cause=http_error,
        )

        assert error.cause is http_error

    def test_multiple_workflow_errors(self) -> None:
        """Test WorkflowError tracking multiple failures."""
        errors: dict[str, BaseException] = {
            "workflow_a": ValueError("Invalid input"),
            "workflow_b": RuntimeError("Connection lost"),
            "workflow_c": TimeoutError("Timed out"),
        }

        error = WorkflowError(
            "orchestrator",
            RuntimeError("Multiple workflows failed"),
            completed=["workflow_x", "workflow_y"],
            errors=errors,
        )

        assert len(error.errors) == 3
        assert isinstance(error.errors["workflow_a"], ValueError)
        assert isinstance(error.errors["workflow_b"], RuntimeError)
        assert isinstance(error.errors["workflow_c"], TimeoutError)


# ============================================================================
# Exception Handling Patterns Tests
# ============================================================================


class TestExceptionHandlingPatterns:
    """Tests for common exception handling patterns."""

    def test_catch_specific_error_type(self) -> None:
        """Test catching specific error type while ignoring others."""
        caught = None

        try:
            raise RateLimitError(retry_after=10.0)
        except RateLimitError as e:
            caught = e
        except ClaudeError:
            pytest.fail("Should have caught RateLimitError specifically")

        assert caught is not None
        assert caught.retry_after == 10.0

    def test_catch_parent_error_type(self) -> None:
        """Test catching parent error type for multiple subtypes."""
        errors_caught: list[ClaudeError] = []

        for error in [
            RateLimitError(),
            ClaudeError("generic"),
        ]:
            try:
                raise error
            except ClaudeError as e:
                errors_caught.append(e)

        assert len(errors_caught) == 2

    def test_catch_base_smithers_error(self) -> None:
        """Test catching SmithersError catches all Smithers errors."""
        error_types = [
            SmithersError("base"),
            WorkflowError("wf", RuntimeError("test")),
            ApprovalRejected("wf"),
            ClaudeError("api"),
            RateLimitError(),
            ToolError("tool", "error"),
            TimeoutError("timeout"),
            WorkflowTimeoutError("wf", 1.0, 2.0),
            GraphTimeoutError(1.0, 2.0),
        ]

        caught_count = 0
        for error in error_types:
            try:
                raise error
            except SmithersError:
                caught_count += 1

        assert caught_count == len(error_types)

    def test_reraise_with_context(self) -> None:
        """Test re-raising error with additional context."""
        try:
            try:
                raise ClaudeError("Original error")
            except ClaudeError as e:
                raise WorkflowError("wrapper", e) from e
        except WorkflowError as outer:
            assert outer.cause is not None
            assert str(outer.cause) == "Original error"
            assert outer.__cause__ is not None
