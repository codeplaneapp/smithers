"""
Example 03: Parallel Execution

Demonstrates automatic parallelization when workflows have independent dependencies.
"""

from pydantic import BaseModel

from smithers import build_graph, claude, run_graph, workflow


class CodeOutput(BaseModel):
    code: str
    language: str
    description: str


class TestOutput(BaseModel):
    test_code: str
    test_count: int
    coverage_areas: list[str]


class DocsOutput(BaseModel):
    documentation: str
    examples: list[str]


class PackageOutput(BaseModel):
    summary: str
    files_created: list[str]
    ready_to_publish: bool


# Step 1: Generate the code
@workflow
async def generate_code() -> CodeOutput:
    """Generate a utility function."""
    return await claude(
        "Write a Python function called `retry_with_backoff` that retries "
        "a function with exponential backoff. Include type hints.",
        output=CodeOutput,
    )


# Step 2a: Generate tests (depends on code)
@workflow
async def generate_tests(code: CodeOutput) -> TestOutput:
    """Generate tests for the code."""
    return await claude(
        f"""
        Write pytest tests for this {code.language} code:
        
        {code.code}
        
        Cover edge cases and error conditions.
        """,
        output=TestOutput,
    )


# Step 2b: Generate docs (depends on code) - runs in PARALLEL with tests!
@workflow
async def generate_docs(code: CodeOutput) -> DocsOutput:
    """Generate documentation for the code."""
    return await claude(
        f"""
        Write documentation for this function:
        
        {code.code}
        
        Include usage examples and parameter descriptions.
        """,
        output=DocsOutput,
    )


# Step 3: Package everything (depends on tests AND docs)
@workflow
async def package_module(
    code: CodeOutput,
    tests: TestOutput,
    docs: DocsOutput,
) -> PackageOutput:
    """Package everything together."""
    return await claude(
        f"""
        Summarize this module package:
        
        Code: {code.description}
        Tests: {tests.test_count} tests covering {", ".join(tests.coverage_areas)}
        Docs: {len(docs.examples)} examples provided
        
        Is it ready to publish?
        """,
        output=PackageOutput,
    )


async def main():
    graph = build_graph(package_module)

    # Show the execution plan
    print("Execution Graph:")
    print(graph.mermaid())
    print()

    # Show parallelization levels
    print("Execution levels (workflows in same level run in parallel):")
    for i, level in enumerate(graph.levels):
        print(f"  Level {i}: {', '.join(level)}")
    print()

    # Execute
    result = await run_graph(graph)

    print(f"Summary: {result.summary}")
    print(f"Ready to publish: {'✅' if result.ready_to_publish else '❌'}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
