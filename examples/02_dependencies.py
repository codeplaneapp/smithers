"""
Example 02: Dependencies

Demonstrates how workflows can depend on each other via type hints.
Smithers automatically resolves the dependency graph.
"""

from pydantic import BaseModel

from smithers import build_graph, claude, run_graph, workflow


class AnalysisOutput(BaseModel):
    topic: str
    key_points: list[str]
    complexity: str  # "simple", "moderate", "complex"


class ExplanationOutput(BaseModel):
    summary: str
    analogy: str
    next_steps: list[str]


@workflow
async def analyze_topic() -> AnalysisOutput:
    """Analyze a technical topic."""
    return await claude(
        "Analyze the concept of 'dependency injection' in software engineering. "
        "Identify the key points and assess its complexity.",
        output=AnalysisOutput,
    )


@workflow
async def explain_topic(analysis: AnalysisOutput) -> ExplanationOutput:
    """Explain a topic based on prior analysis.

    Note: `analysis` is automatically provided by Smithers from `analyze_topic`.
    """
    return await claude(
        f"""
        Based on this analysis of '{analysis.topic}':
        
        Key points: {", ".join(analysis.key_points)}
        Complexity: {analysis.complexity}
        
        Create a beginner-friendly explanation with a relatable analogy.
        """,
        output=ExplanationOutput,
    )


async def main():
    # Build graph from the final workflow - deps are resolved automatically
    graph = build_graph(explain_topic)

    # Visualize what will run
    print("Execution plan:")
    print(graph.mermaid())
    print()

    # Execute
    result = await run_graph(graph)

    print(f"Summary: {result.summary}")
    print(f"\nAnalogy: {result.analogy}")
    print("\nNext steps:")
    for step in result.next_steps:
        print(f"  - {step}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
