"""Claude LLM integration."""

from typing import TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


async def claude(
    prompt: str,
    *,
    output: type[T],
    tools: list[str] | None = None,
    system: str | None = None,
    max_turns: int = 10,
    model: str = "claude-sonnet-4-20250514",
) -> T:
    """
    Call Claude with a prompt and get structured output.

    Args:
        prompt: The prompt to send to Claude
        output: Pydantic model class for structured output
        tools: List of tool names Claude can use (e.g., ["Read", "Edit", "Bash"])
        system: Optional system prompt
        max_turns: Maximum number of tool-use turns
        model: Claude model to use

    Returns:
        Parsed response as the specified Pydantic model

    Example:
        result = await claude(
            "Analyze this code",
            tools=["Read", "Grep"],
            output=AnalysisOutput,
        )
    """
    # TODO: Implement Claude API integration
    # This is a placeholder that will be replaced with the real implementation
    raise NotImplementedError("claude is not yet implemented")
