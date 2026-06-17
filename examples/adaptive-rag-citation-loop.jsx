// @ts-nocheck
/**
 * <AdaptiveRagCitationLoop> - Route, retrieve, grade, and repair a cited answer.
 *
 * Pattern: query routing -> retrieval plan -> parallel evidence gathering ->
 * answer draft -> citation judge -> repair loop or human review.
 * Use cases: policy assistants, support knowledge search, research copilots,
 * regulated answers that require sentence-level citations.
 *
 * Smithers implementation: retrieval and judging are separate persisted tasks,
 * so each retry shows exactly which evidence was used and why the judge accepted
 * or rejected the groundedness of the answer.
 */
import { Sequence, Parallel, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import RoutePrompt from "./prompts/adaptive-rag-citation-loop/route.mdx";
import PlanRetrievalPrompt from "./prompts/adaptive-rag-citation-loop/plan-retrieval.mdx";
import RetrievePrompt from "./prompts/adaptive-rag-citation-loop/retrieve.mdx";
import DraftAnswerPrompt from "./prompts/adaptive-rag-citation-loop/draft-answer.mdx";
import CitationJudgePrompt from "./prompts/adaptive-rag-citation-loop/citation-judge.mdx";
import RepairPlanPrompt from "./prompts/adaptive-rag-citation-loop/repair-plan.mdx";
import FinalPrompt from "./prompts/adaptive-rag-citation-loop/final.mdx";

const routeSchema = z.object({
    mode: z.enum(["answer-from-memory", "retrieve", "retrieve-and-use-tool", "insufficient"]),
    reason: z.string(),
    risk: z.enum(["low", "medium", "high"]),
});

const retrievalPlanSchema = z.object({
    subqueries: z.array(z.string()),
    sources: z.array(z.enum(["vector", "keyword", "web", "database"])),
    mustCite: z.boolean(),
    gapsToClose: z.array(z.string()),
});

const evidenceSchema = z.object({
    source: z.string(),
    query: z.string(),
    claims: z.array(z.object({
        claim: z.string(),
        sourceId: z.string(),
        quoteOrLocation: z.string(),
        confidence: z.number().min(0).max(1),
    })),
    gaps: z.array(z.string()),
});

const answerSchema = z.object({
    answer: z.string(),
    citations: z.array(z.object({
        sentence: z.string(),
        sourceIds: z.array(z.string()),
    })),
    unresolvedQuestions: z.array(z.string()),
});

const gradeSchema = z.object({
    grounded: z.boolean(),
    score: z.number().min(0).max(1),
    missingEvidence: z.array(z.string()),
    unsupportedSentences: z.array(z.string()),
});

const approvalSchema = z.object({
    approved: z.boolean(),
    reviewer: z.string(),
    note: z.string(),
});

const finalSchema = z.object({
    status: z.enum(["answered", "needs-human-review", "insufficient-evidence"]),
    answer: z.string(),
    citationCount: z.number(),
    gaps: z.array(z.string()),
    summary: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
    route: routeSchema,
    retrievalPlan: retrievalPlanSchema,
    evidence: evidenceSchema,
    answer: answerSchema,
    grade: gradeSchema,
    approval: approvalSchema,
    final: finalSchema,
});

const routerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are a query router. Decide whether the question can be answered
from stable memory, requires retrieval, requires tool/database lookup, or lacks enough context.`,
});

const plannerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are an agentic RAG planner. Break the question into subqueries,
choose source types, and list evidence gaps that must be closed before answering.`,
});

const retrieverAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, bash, grep },
    instructions: `You are an evidence retriever. Search the requested corpus or source
type and return atomic claims with source IDs, locations, and confidence scores.`,
});

const writerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are a cited-answer writer. Every factual sentence must map to
source IDs. Do not invent citations. Preserve open questions instead of guessing.`,
});

const judgeAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are a citation and faithfulness judge. Check whether the answer
is fully supported by the evidence and name every unsupported sentence or missing fact.`,
});

export default smithers((ctx) => {
    const route = ctx.outputMaybe("route", { nodeId: "route-query" });
    const plan = ctx.outputMaybe("retrievalPlan", { nodeId: "plan-retrieval" }) ??
        ctx.outputMaybe("retrievalPlan", { nodeId: "repair-retrieval-plan" });
    const grade = ctx.outputMaybe("grade", { nodeId: "citation-judge" });
    const answer = ctx.outputMaybe("answer", { nodeId: "draft-answer" });
    const threshold = ctx.input.groundedThreshold ?? 0.85;
    const grounded = grade?.grounded === true && (grade?.score ?? 0) >= threshold;
    const shouldRetrieve = route ? route.mode !== "answer-from-memory" : true;
    const needsReview = Boolean(grade && !grounded && (grade.score < (ctx.input.reviewThreshold ?? 0.75)));

    return (
        <Workflow name="adaptive-rag-citation-loop">
            <Sequence>
                <Task id="route-query" output={outputs.route} agent={routerAgent}>
                    <RoutePrompt question={ctx.input.question} riskPolicy={ctx.input.riskPolicy ?? "Escalate high-risk or unsupported claims."} />
                </Task>

                <Task id="plan-retrieval" output={outputs.retrievalPlan} agent={plannerAgent} skipIf={!shouldRetrieve}>
                    <PlanRetrievalPrompt
                        question={ctx.input.question}
                        route={route}
                        corpus={ctx.input.corpus ?? "fixtures/adaptive-rag"}
                        requiredCitationPolicy={ctx.input.requiredCitationPolicy ?? "Cite every factual sentence."}
                    />
                </Task>

                <Loop
                    until={grounded}
                    maxIterations={ctx.input.maxIterations ?? 3}
                    onMaxReached="return-last"
                >
                    <Sequence>
                        <Branch
                            if={shouldRetrieve}
                            then={
                                <Parallel maxConcurrency={3}>
                                    <Task id="vector-search" output={outputs.evidence} agent={retrieverAgent}>
                                        <RetrievePrompt source="vector" plan={plan} question={ctx.input.question} />
                                    </Task>
                                    <Task id="keyword-search" output={outputs.evidence} agent={retrieverAgent}>
                                        <RetrievePrompt source="keyword" plan={plan} question={ctx.input.question} />
                                    </Task>
                                    <Task id="source-fetch" output={outputs.evidence} agent={retrieverAgent}>
                                        <RetrievePrompt source={plan?.sources?.includes("database") ? "database" : "web"} plan={plan} question={ctx.input.question} />
                                    </Task>
                                </Parallel>
                            }
                            else={null}
                        />

                        <Task id="draft-answer" output={outputs.answer} agent={writerAgent}>
                            <DraftAnswerPrompt
                                question={ctx.input.question}
                                route={route}
                                evidence={ctx.outputs.evidence ?? []}
                                previousGrade={grade}
                            />
                        </Task>

                        <Task id="citation-judge" output={outputs.grade} agent={judgeAgent}>
                            <CitationJudgePrompt
                                question={ctx.input.question}
                                answer={answer}
                                evidence={ctx.outputs.evidence ?? []}
                                threshold={threshold}
                            />
                        </Task>

                        <Task id="repair-retrieval-plan" output={outputs.retrievalPlan} agent={plannerAgent} skipIf={grounded || !shouldRetrieve}>
                            <RepairPlanPrompt
                                question={ctx.input.question}
                                priorPlan={plan}
                                grade={grade}
                                evidence={ctx.outputs.evidence ?? []}
                            />
                        </Task>
                    </Sequence>
                </Loop>

                <Branch
                    if={needsReview}
                    then={
                        <Approval
                            id="human-review"
                            output={outputs.approval}
                            request={{
                                title: "Review insufficiently grounded answer",
                                summary: `Citation score ${grade?.score ?? 0}; missing evidence: ${(grade?.missingEvidence ?? []).join(", ") || "none listed"}`,
                            }}
                        />
                    }
                    else={null}
                />

                <Task id="final-answer" output={outputs.final} agent={writerAgent}>
                    <FinalPrompt
                        question={ctx.input.question}
                        answer={answer}
                        grade={grade}
                        approval={ctx.outputMaybe("approval", { nodeId: "human-review" })}
                        grounded={grounded}
                    />
                </Task>
            </Sequence>
        </Workflow>
    );
});
