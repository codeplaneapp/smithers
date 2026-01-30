"""
Example 07: Deep Research Agent

A multi-stage research pipeline that:
1. Plans the research approach
2. Executes parallel research streams
3. Synthesizes findings
4. Generates a report with citations
"""

from pydantic import BaseModel

from smithers import build_graph, claude, run_graph, workflow

# --- Output Models ---


class ResearchPlan(BaseModel):
    question: str
    sub_questions: list[str]
    search_strategy: str
    expected_sources: list[str]


class SearchResult(BaseModel):
    query: str
    findings: list[str]
    sources: list[str]
    confidence: float


class Analysis(BaseModel):
    key_themes: list[str]
    contradictions: list[str]
    gaps: list[str]
    strongest_evidence: list[str]


class Report(BaseModel):
    title: str
    executive_summary: str
    sections: list[str]
    conclusions: list[str]
    citations: list[str]
    confidence_score: float


# --- Workflows ---


@workflow
async def plan_research() -> ResearchPlan:
    """Create a research plan for the question."""
    return await claude(
        """
        Create a research plan for this question:
        
        "What are the best practices for building reliable AI agent systems?"
        
        Break it down into sub-questions and identify what sources to consult.
        """,
        output=ResearchPlan,
    )


@workflow
async def search_academic(plan: ResearchPlan) -> SearchResult:
    """Search academic sources."""
    return await claude(
        f"""
        Search for academic/research sources on: {plan.question}
        
        Focus on these sub-questions:
        {chr(10).join(f"- {q}" for q in plan.sub_questions[:2])}
        
        Look for peer-reviewed papers, technical reports, and academic blogs.
        """,
        tools=["web_search", "read_web_page"],
        system="You are an academic researcher. Cite your sources.",
        output=SearchResult,
    )


@workflow
async def search_industry(plan: ResearchPlan) -> SearchResult:
    """Search industry sources."""
    return await claude(
        f"""
        Search for industry sources on: {plan.question}
        
        Focus on these sub-questions:
        {chr(10).join(f"- {q}" for q in plan.sub_questions[2:])}
        
        Look for blog posts from companies, conference talks, and documentation.
        """,
        tools=["web_search", "read_web_page"],
        system="You are an industry analyst. Focus on practical implementations.",
        output=SearchResult,
    )


@workflow
async def search_code(plan: ResearchPlan) -> SearchResult:
    """Search code examples and repositories."""
    return await claude(
        f"""
        Search for code examples related to: {plan.question}
        
        Look for:
        - Popular open source projects
        - Code patterns and architectures
        - Library documentation and examples
        """,
        tools=["web_search", "read_web_page"],
        system="You are a developer researching implementations.",
        output=SearchResult,
    )


@workflow
async def analyze_findings(
    academic: SearchResult,
    industry: SearchResult,
    code: SearchResult,
) -> Analysis:
    """Analyze and synthesize all research findings."""
    return await claude(
        f"""
        Analyze these research findings:
        
        Academic findings ({academic.confidence:.0%} confidence):
        {chr(10).join(f"- {f}" for f in academic.findings)}
        
        Industry findings ({industry.confidence:.0%} confidence):
        {chr(10).join(f"- {f}" for f in industry.findings)}
        
        Code examples ({code.confidence:.0%} confidence):
        {chr(10).join(f"- {f}" for f in code.findings)}
        
        Identify themes, contradictions, and gaps.
        """,
        output=Analysis,
    )


@workflow
async def generate_report(
    plan: ResearchPlan,
    analysis: Analysis,
    academic: SearchResult,
    industry: SearchResult,
    code: SearchResult,
) -> Report:
    """Generate the final research report."""
    all_sources = academic.sources + industry.sources + code.sources
    avg_confidence = (academic.confidence + industry.confidence + code.confidence) / 3

    return await claude(
        f"""
        Generate a research report on: {plan.question}
        
        Key themes identified:
        {chr(10).join(f"- {t}" for t in analysis.key_themes)}
        
        Strongest evidence:
        {chr(10).join(f"- {e}" for e in analysis.strongest_evidence)}
        
        Gaps to acknowledge:
        {chr(10).join(f"- {g}" for g in analysis.gaps)}
        
        Available sources: {len(all_sources)}
        Average confidence: {avg_confidence:.0%}
        
        Write an executive summary, organize into sections, and draw conclusions.
        """,
        output=Report,
    )


async def main():
    graph = build_graph(generate_report)

    print("Research Agent Pipeline")
    print("=" * 50)
    print()
    print(graph.mermaid())
    print()
    print("Execution levels:")
    for i, level in enumerate(graph.levels):
        print(f"  {i}: {', '.join(level)}")
    print()

    print("Running research pipeline...")
    print()

    result = await run_graph(graph)

    print(f"📄 {result.title}")
    print()
    print("Executive Summary:")
    print(result.executive_summary)
    print()
    print(f"Confidence: {result.confidence_score:.0%}")
    print(f"Citations: {len(result.citations)}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
