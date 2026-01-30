"""
Example 05: Tools

Demonstrates workflows that use Claude's tool-use capabilities
to interact with files, run commands, etc.
"""

from pydantic import BaseModel

from smithers import build_graph, claude, run_graph, workflow


class CodeReviewOutput(BaseModel):
    files_reviewed: list[str]
    issues_found: list[str]
    suggestions: list[str]
    overall_quality: str  # "excellent", "good", "needs_work", "poor"


class FixOutput(BaseModel):
    files_modified: list[str]
    changes_made: list[str]
    tests_passed: bool


class ReportOutput(BaseModel):
    summary: str
    before_quality: str
    after_quality: str
    improvement_notes: list[str]


@workflow
async def review_code() -> CodeReviewOutput:
    """Review Python files in the current directory."""
    return await claude(
        "Review the Python files in src/smithers/. "
        "Look for bugs, style issues, and potential improvements.",
        tools=["Read", "Glob", "Grep"],
        output=CodeReviewOutput,
    )


@workflow
async def fix_issues(review: CodeReviewOutput) -> FixOutput:
    """Fix the issues found in code review."""
    if review.overall_quality == "excellent":
        # No fixes needed
        return FixOutput(
            files_modified=[],
            changes_made=["No changes needed - code is excellent!"],
            tests_passed=True,
        )

    return await claude(
        f"""
        Fix these issues found during code review:
        
        Issues:
        {chr(10).join(f"- {issue}" for issue in review.issues_found)}
        
        Suggestions:
        {chr(10).join(f"- {s}" for s in review.suggestions)}
        
        Apply fixes and run tests to verify.
        """,
        tools=["Read", "Edit", "Bash"],
        output=FixOutput,
    )


@workflow
async def generate_report(
    review: CodeReviewOutput,
    fixes: FixOutput,
) -> ReportOutput:
    """Generate a final report."""
    return await claude(
        f"""
        Generate a code quality report:
        
        Initial review:
        - Quality: {review.overall_quality}
        - Issues: {len(review.issues_found)}
        
        Fixes applied:
        - Files modified: {len(fixes.files_modified)}
        - Tests passed: {"Yes" if fixes.tests_passed else "No"}
        """,
        output=ReportOutput,
    )


async def main():
    graph = build_graph(generate_report)

    print("Code Review Pipeline")
    print("=" * 40)
    print(graph.mermaid())
    print()

    result = await run_graph(graph)

    print(f"Summary: {result.summary}")
    print(f"Quality: {result.before_quality} → {result.after_quality}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
