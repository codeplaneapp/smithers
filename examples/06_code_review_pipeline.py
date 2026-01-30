"""
Example 06: Complete Code Review Pipeline

A realistic example of a multi-agent code review system with:
- Parallel reviewers (security, performance, style)
- Aggregated feedback
- Human approval gate
- Automated fixes
"""

from pydantic import BaseModel

from smithers import build_graph, claude, require_approval, run_graph, workflow

# --- Output Models ---


class SecurityReview(BaseModel):
    vulnerabilities: list[str]
    risk_level: str  # "none", "low", "medium", "high", "critical"
    recommendations: list[str]


class PerformanceReview(BaseModel):
    bottlenecks: list[str]
    complexity_score: int  # 1-10
    optimization_suggestions: list[str]


class StyleReview(BaseModel):
    violations: list[str]
    readability_score: int  # 1-10
    formatting_issues: list[str]


class AggregatedReview(BaseModel):
    total_issues: int
    critical_issues: list[str]
    should_block_merge: bool
    summary: str


class FixResult(BaseModel):
    issues_fixed: int
    files_changed: list[str]
    remaining_issues: list[str]


# --- Workflows ---


@workflow
async def review_security() -> SecurityReview:
    """Security-focused code review."""
    return await claude(
        "Review the codebase for security vulnerabilities. "
        "Check for: SQL injection, XSS, auth issues, secrets in code, "
        "insecure dependencies, and unsafe deserialization.",
        tools=["Read", "Glob", "Grep"],
        system="You are a security expert focused on finding vulnerabilities.",
        output=SecurityReview,
    )


@workflow
async def review_performance() -> PerformanceReview:
    """Performance-focused code review."""
    return await claude(
        "Review the codebase for performance issues. "
        "Check for: N+1 queries, memory leaks, unnecessary loops, "
        "missing caching opportunities, and blocking operations.",
        tools=["Read", "Glob", "Grep"],
        system="You are a performance engineer focused on optimization.",
        output=PerformanceReview,
    )


@workflow
async def review_style() -> StyleReview:
    """Style and readability review."""
    return await claude(
        "Review the codebase for style and readability. "
        "Check for: naming conventions, function length, documentation, "
        "type hints, and code organization.",
        tools=["Read", "Glob", "Grep"],
        system="You are a senior engineer focused on code quality.",
        output=StyleReview,
    )


@workflow
async def aggregate_reviews(
    security: SecurityReview,
    performance: PerformanceReview,
    style: StyleReview,
) -> AggregatedReview:
    """Aggregate all reviews into a single report."""
    total_issues = (
        len(security.vulnerabilities) + len(performance.bottlenecks) + len(style.violations)
    )

    critical = []
    if security.risk_level in ("high", "critical"):
        critical.extend(security.vulnerabilities)

    should_block = security.risk_level in ("high", "critical") or total_issues > 10

    return await claude(
        f"""
        Aggregate these code reviews into a summary:
        
        Security ({security.risk_level} risk):
        - {len(security.vulnerabilities)} vulnerabilities
        
        Performance (complexity: {performance.complexity_score}/10):
        - {len(performance.bottlenecks)} bottlenecks
        
        Style (readability: {style.readability_score}/10):
        - {len(style.violations)} violations
        
        Total issues: {total_issues}
        Should block merge: {should_block}
        """,
        output=AggregatedReview,
    )


@workflow
@require_approval("Apply automated fixes to the codebase?")
async def apply_fixes(
    review: AggregatedReview,
    security: SecurityReview,
    performance: PerformanceReview,
    style: StyleReview,
) -> FixResult:
    """Apply automated fixes for issues found."""
    if not review.should_block_merge:
        return FixResult(
            issues_fixed=0,
            files_changed=[],
            remaining_issues=["No critical issues - skipping fixes"],
        )

    return await claude(
        f"""
        Apply fixes for these issues:
        
        Security (priority):
        {chr(10).join(f"- {v}" for v in security.vulnerabilities)}
        
        Performance:
        {chr(10).join(f"- {b}" for b in performance.bottlenecks)}
        
        Style:
        {chr(10).join(f"- {v}" for v in style.violations)}
        
        Fix what you can automatically, list what remains.
        """,
        tools=["Read", "Edit", "Bash"],
        output=FixResult,
    )


async def main():
    graph = build_graph(apply_fixes)

    print("Code Review Pipeline")
    print("=" * 50)
    print()
    print("Graph structure:")
    print(graph.mermaid())
    print()
    print("Execution levels:")
    for i, level in enumerate(graph.levels):
        workflows = ", ".join(level)
        parallel = " (parallel)" if len(level) > 1 else ""
        print(f"  {i}: {workflows}{parallel}")
    print()

    result = await run_graph(graph)

    print("Results:")
    print(f"  Issues fixed: {result.issues_fixed}")
    print(f"  Files changed: {len(result.files_changed)}")
    if result.remaining_issues:
        print("  Remaining issues:")
        for issue in result.remaining_issues:
            print(f"    - {issue}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
