"""
Example 04: Caching

Demonstrates SQLite-based caching to skip unchanged workflows.
"""

from pydantic import BaseModel

from smithers import SqliteCache, build_graph, claude, run_graph, workflow


class ResearchOutput(BaseModel):
    findings: list[str]
    sources_consulted: int
    confidence: float


class SynthesisOutput(BaseModel):
    conclusion: str
    key_insights: list[str]
    recommendations: list[str]


@workflow
async def research_topic() -> ResearchOutput:
    """Conduct research on a topic."""
    return await claude(
        "Research the current state of Python async/await best practices. Provide key findings.",
        output=ResearchOutput,
    )


@workflow
async def synthesize(research: ResearchOutput) -> SynthesisOutput:
    """Synthesize research into actionable insights."""
    return await claude(
        f"""
        Based on these research findings:
        
        {chr(10).join(f"- {f}" for f in research.findings)}
        
        Confidence level: {research.confidence:.0%}
        
        Synthesize into a conclusion with recommendations.
        """,
        output=SynthesisOutput,
    )


async def main():
    # Create a persistent cache
    cache = SqliteCache("./smithers_cache.db")

    graph = build_graph(synthesize)

    # First run - executes all workflows
    print("First run (no cache):")
    result1 = await run_graph(graph, cache=cache)
    print(f"  Conclusion: {result1.conclusion[:80]}...")
    print()

    # Second run - skips workflows with unchanged inputs
    print("Second run (cached):")
    result2 = await run_graph(graph, cache=cache)
    print(f"  Conclusion: {result2.conclusion[:80]}...")
    print("  ⚡ Retrieved from cache!")
    print()

    # Show cache stats
    stats = await cache.stats()
    print("Cache stats:")
    print(f"  Entries: {stats.entries}")
    print(f"  Hits: {stats.hits}")
    print(f"  Misses: {stats.misses}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
