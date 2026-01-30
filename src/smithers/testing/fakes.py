"""Fake providers for deterministic testing."""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, TypeAdapter

T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLMCall:
    """Record of a call to the fake LLM provider."""

    prompt: str
    output_type: type[BaseModel]
    tools: list[str] | None
    system: str | None
    response: Any


@dataclass
class FakeLLMProvider:
    """
    Fake LLM provider for deterministic testing.

    Usage with sequential responses (for sequential execution):
        fake = FakeLLMProvider(responses=[
            {"files": ["a.py"], "summary": "Test"},
            {"changed_files": ["a.py"]},
        ])

        with use_fake_llm(fake):
            result = await analyze()
            assert result.files == ["a.py"]

        # Inspect calls
        assert len(fake.calls) == 1
        assert fake.calls[0].prompt == "..."

    Usage with type-based responses (for parallel execution):
        fake = FakeLLMProvider(responses_by_type={
            AnalysisOutput: {"files": ["a.py"], "summary": "Test"},
            ImplementOutput: {"changed_files": ["a.py"]},
        })

        with use_fake_llm(fake):
            # Works regardless of execution order
            result = await run_graph(graph)
    """

    responses: list[dict[str, Any] | BaseModel] = field(default_factory=list)
    responses_by_type: dict[type[BaseModel], dict[str, Any] | BaseModel] = field(
        default_factory=dict
    )
    calls: list[FakeLLMCall] = field(default_factory=list)
    _index: int = field(default=0, init=False)

    def add_response(self, response: dict[str, Any] | BaseModel) -> None:
        """Add a response to the sequential queue."""
        self.responses.append(response)

    def set_response_for_type(
        self, output_type: type[BaseModel], response: dict[str, Any] | BaseModel
    ) -> None:
        """Set a response for a specific output type (for parallel execution)."""
        self.responses_by_type[output_type] = response

    def next_response(
        self,
        prompt: str,
        output_type: type[T],
        tools: list[str] | None,
        system: str | None,
    ) -> T:
        """Get the next response and record the call."""
        # First, check if we have a type-specific response
        raw_response: dict[str, Any] | BaseModel | None = None

        if output_type in self.responses_by_type:
            raw_response = self.responses_by_type[output_type]
        elif self._index < len(self.responses):
            raw_response = self.responses[self._index]
            self._index += 1
        else:
            raise RuntimeError(
                f"FakeLLMProvider exhausted: expected call for {output_type.__name__}, "
                f"but no response available (sequential index={self._index}, "
                f"responses={len(self.responses)}, type not in responses_by_type)"
            )

        # Validate and convert response
        adapter = TypeAdapter(output_type)
        if isinstance(raw_response, BaseModel):
            validated = adapter.validate_python(raw_response.model_dump())
        else:
            validated = adapter.validate_python(raw_response)

        self.calls.append(
            FakeLLMCall(
                prompt=prompt,
                output_type=output_type,
                tools=tools,
                system=system,
                response=validated,
            )
        )

        return validated

    def reset(self) -> None:
        """Reset the provider for reuse."""
        self._index = 0
        self.calls.clear()


@dataclass
class FakeToolResult:
    """Result from a fake tool invocation."""

    tool_name: str
    input_args: dict[str, Any]
    output: Any


@dataclass
class FakeToolProvider:
    """
    Fake tool provider for deterministic testing.

    Usage:
        fake_tools = FakeToolProvider(responses={
            "Read": {"path": "test.py", "content": "print('hello')"},
            "Bash": {"exit_code": 0, "stdout": "ok", "stderr": ""},
        })
    """

    responses: dict[str, Any] = field(default_factory=dict)
    calls: list[FakeToolResult] = field(default_factory=list)

    def set_response(self, tool_name: str, response: Any) -> None:
        """Set the response for a specific tool."""
        self.responses[tool_name] = response

    async def invoke(self, tool_name: str, args: dict[str, Any]) -> Any:
        """Invoke a fake tool and record the call."""
        if tool_name not in self.responses:
            raise RuntimeError(f"No fake response configured for tool: {tool_name}")

        response = self.responses[tool_name]
        self.calls.append(
            FakeToolResult(
                tool_name=tool_name,
                input_args=args,
                output=response,
            )
        )

        # Support callable responses for dynamic behavior
        if callable(response):
            return response(args)
        return response


# Global state for fake provider injection
_fake_llm_provider: FakeLLMProvider | None = None


def get_fake_llm_provider() -> FakeLLMProvider | None:
    """Get the currently active fake LLM provider."""
    return _fake_llm_provider


@contextlib.contextmanager
def use_fake_llm(provider: FakeLLMProvider) -> Iterator[FakeLLMProvider]:
    """
    Context manager to inject a fake LLM provider.

    Usage:
        fake = FakeLLMProvider(responses=[...])
        with use_fake_llm(fake):
            result = await my_workflow()
    """
    global _fake_llm_provider
    old_provider = _fake_llm_provider
    _fake_llm_provider = provider
    try:
        yield provider
    finally:
        _fake_llm_provider = old_provider


@contextlib.asynccontextmanager
async def use_fake_llm_async(
    provider: FakeLLMProvider,
) -> AsyncIterator[FakeLLMProvider]:
    """Async context manager variant of use_fake_llm."""
    with use_fake_llm(provider):
        yield provider


@contextlib.contextmanager
def use_runtime(
    *,
    llm: FakeLLMProvider | None = None,
    tools: FakeToolProvider | None = None,
) -> Iterator[None]:
    """
    Context manager to inject fake providers for testing.

    This is the recommended API for testing workflows, matching
    the specification in ARCHITECTURE.md.

    Example:
        from smithers.testing import FakeLLMProvider, use_runtime

        async def test_analyze_with_fake_llm():
            fake = FakeLLMProvider(responses=[
                {"files": ["x.py"], "summary": "ok"}
            ])
            with use_runtime(llm=fake):
                out = await analyze()
                assert out.files == ["x.py"]

    Args:
        llm: Fake LLM provider to use for claude() calls
        tools: Fake tool provider (reserved for future use)
    """
    global _fake_llm_provider
    old_provider = _fake_llm_provider
    if llm is not None:
        _fake_llm_provider = llm
    try:
        yield
    finally:
        _fake_llm_provider = old_provider


@contextlib.asynccontextmanager
async def use_runtime_async(
    *,
    llm: FakeLLMProvider | None = None,
    tools: FakeToolProvider | None = None,
) -> AsyncIterator[None]:
    """Async variant of use_runtime context manager."""
    with use_runtime(llm=llm, tools=tools):
        yield
