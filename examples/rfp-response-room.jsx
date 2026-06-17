// @ts-nocheck
/**
 * <RfpResponseRoom> - Ingest an RFP, draft cited answers, review, and package.
 *
 * Pattern: RFP intake -> requirement matrix -> approved-content retrieval ->
 * parallel drafting -> reviewer passes -> SME approval -> proposal package.
 * Use cases: RFP responses, security questionnaires, vendor assessments,
 * enterprise sales proposals.
 *
 * Smithers implementation: each requirement draft is a separate parallel task,
 * review roles are separate gates, and low-confidence claims route to a human
 * approval before the final package is assembled.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ParsePrompt from "./prompts/rfp-response-room/parse.mdx";
import PlanPrompt from "./prompts/rfp-response-room/plan.mdx";
import DraftPrompt from "./prompts/rfp-response-room/draft.mdx";
import ReviewPrompt from "./prompts/rfp-response-room/review.mdx";
import PackagePrompt from "./prompts/rfp-response-room/package.mdx";

function nodeId(value) {
    return String(value ?? "item").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "item";
}

const requirementSchema = z.object({
    id: z.string(),
    section: z.string(),
    question: z.string(),
    mandatory: z.boolean(),
    topic: z.enum(["security", "legal", "implementation", "pricing", "support", "other"]),
});

const rfpSchema = z.object({
    opportunityName: z.string(),
    customer: z.string(),
    dueDate: z.string(),
    requirements: z.array(requirementSchema),
    submissionInstructions: z.array(z.string()),
});

const answerPlanSchema = z.object({
    workstreams: z.array(z.object({
        topic: z.string(),
        ownerRole: z.string(),
        requirementIds: z.array(z.string()),
    })),
    sourceCollections: z.array(z.string()),
    risks: z.array(z.string()),
});

const answerDraftSchema = z.object({
    requirementId: z.string(),
    topic: z.string(),
    answer: z.string(),
    citedSourceIds: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    needsSME: z.boolean(),
});

const reviewSchema = z.object({
    reviewerRole: z.enum(["sales", "security", "legal", "product", "proposal-manager"]),
    approved: z.boolean(),
    requirementIds: z.array(z.string()),
    blockers: z.array(z.string()),
    suggestedEdits: z.array(z.string()),
});

const approvalSchema = z.object({
    approved: z.boolean(),
    reviewer: z.string(),
    note: z.string(),
});

const proposalPackageSchema = z.object({
    files: z.array(z.string()),
    openQuestions: z.array(z.string()),
    submissionReady: z.boolean(),
    summary: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
    rfp: rfpSchema,
    answerPlan: answerPlanSchema,
    answerDraft: answerDraftSchema,
    review: reviewSchema,
    approval: approvalSchema,
    proposalPackage: proposalPackageSchema,
});

const parserAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep, bash },
    instructions: `You are an RFP intake analyst. Parse the source RFP into a requirement
matrix with stable IDs, mandatory flags, topics, and submission instructions.`,
});

const plannerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are a proposal manager. Build an answer plan that maps each
requirement to approved source material, owner roles, and risks.`,
});

const draftAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are an RFP response drafter. Use only approved source material,
cite source IDs, mark low-confidence answers, and never invent capabilities.`,
});

const reviewerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are a proposal reviewer. Check drafts for source support,
policy compliance, overclaims, and reviewer-specific blockers.`,
});

const packagerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, write, bash },
    instructions: `You are a proposal packager. Assemble reviewed answers into the
requested output files, list open questions, and mark whether the package is ready.`,
});

export default smithers((ctx) => {
    const rfp = ctx.outputMaybe("rfp", { nodeId: "parse-rfp" });
    const requirements = rfp?.requirements ?? [];
    const drafts = ctx.outputs.answerDraft ?? [];
    const reviews = ctx.outputs.review ?? [];
    const lowConfidence = drafts.some((draft) => draft.needsSME || draft.confidence < (ctx.input.confidenceThreshold ?? 0.8));
    const blocked = reviews.some((review) => !review.approved || review.blockers.length > 0);

    return (
        <Workflow name="rfp-response-room">
            <Sequence>
                <Task id="parse-rfp" output={outputs.rfp} agent={parserAgent}>
                    <ParsePrompt
                        rfp={ctx.input.rfp ?? "fixtures/rfp-response-room/rfp.md"}
                        customer={ctx.input.customer ?? "Example customer"}
                    />
                </Task>

                <Task id="build-answer-plan" output={outputs.answerPlan} agent={plannerAgent}>
                    <PlanPrompt
                        rfp={rfp}
                        approvedSources={ctx.input.approvedSources ?? "fixtures/rfp-response-room/approved-answers"}
                        pricingRules={ctx.input.pricingRules ?? "fixtures/rfp-response-room/pricing-rules.md"}
                    />
                </Task>

                {requirements.length > 0 && (
                    <Parallel maxConcurrency={ctx.input.maxDraftConcurrency ?? 8}>
                        {requirements.map((requirement) => (
                            <Task
                                key={requirement.id}
                                id={`draft-${nodeId(requirement.id)}`}
                                output={outputs.answerDraft}
                                agent={draftAgent}
                            >
                                <DraftPrompt
                                    requirement={requirement}
                                    answerPlan={ctx.outputMaybe("answerPlan", { nodeId: "build-answer-plan" })}
                                    approvedSources={ctx.input.approvedSources ?? "fixtures/rfp-response-room/approved-answers"}
                                />
                            </Task>
                        ))}
                    </Parallel>
                )}

                <Parallel maxConcurrency={3}>
                    <Task id="security-review" output={outputs.review} agent={reviewerAgent}>
                        <ReviewPrompt role="security" drafts={drafts} rfp={rfp} />
                    </Task>
                    <Task id="legal-review" output={outputs.review} agent={reviewerAgent}>
                        <ReviewPrompt role="legal" drafts={drafts} rfp={rfp} />
                    </Task>
                    <Task id="product-review" output={outputs.review} agent={reviewerAgent}>
                        <ReviewPrompt role="product" drafts={drafts} rfp={rfp} />
                    </Task>
                </Parallel>

                <Branch
                    if={lowConfidence || blocked}
                    then={
                        <Approval
                            id="sme-review"
                            output={outputs.approval}
                            request={{
                                title: "Review RFP response exceptions",
                                summary: `${drafts.filter((draft) => draft.needsSME || draft.confidence < 0.8).length} low-confidence draft(s); ${reviews.flatMap((review) => review.blockers).length} blocker(s).`,
                            }}
                        />
                    }
                    else={null}
                />

                <Task id="package-proposal" output={outputs.proposalPackage} agent={packagerAgent}>
                    <PackagePrompt
                        rfp={rfp}
                        drafts={drafts}
                        reviews={reviews}
                        approval={ctx.outputMaybe("approval", { nodeId: "sme-review" })}
                        outputFormat={ctx.input.outputFormat ?? "markdown"}
                    />
                </Task>
            </Sequence>
        </Workflow>
    );
});
