/**
 * <TrustSafetyModerator> — Screen content, classify policy/risk, and route edge cases for review.
 *
 * Pattern: Content intake → moderator agent → policy-specific action or escalation.
 * Use cases: user-generated content moderation, AI output screening, policy enforcement,
 * abuse detection, compliance gating.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/trust-safety-moderator/intake.mdx";
import ModeratePrompt from "./prompts/trust-safety-moderator/moderate.mdx";
import ActionPrompt from "./prompts/trust-safety-moderator/action.mdx";
const intakeSchema = z.object({
    contentId: z.string(),
    contentType: z.enum(["text", "image_url", "structured", "mixed"]),
    rawText: z.string(),
    metadata: z.object({
        source: z.string(),
        authorId: z.string().optional(),
        timestamp: z.string().optional(),
    }),
});
const moderationSchema = z.object({
    contentId: z.string(),
    riskLevel: z.enum(["allow", "low", "medium", "high", "block"]),
    policyClass: z.enum([
        "safe",
        "harassment",
        "hate_speech",
        "violence",
        "sexual_content",
        "self_harm",
        "pii_leak",
        "misinformation",
        "spam",
        "copyright",
        "other",
    ]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    flaggedSegments: z.array(z.object({
        text: z.string(),
        policy: z.string(),
        severity: z.enum(["low", "medium", "high"]),
    })),
    needsHumanReview: z.boolean(),
});
const actionSchema = z.object({
    contentId: z.string(),
    decision: z.enum(["approved", "modified", "rejected", "escalated"]),
    action: z.string(),
    moderatedContent: z.string().optional(),
    escalationReason: z.string().optional(),
    summary: z.string(),
});
const { Workflow, Task, smithers, outputs } = createExampleSmithers({
    intake: intakeSchema,
    moderation: moderationSchema,
    action: actionSchema,
});
const moderator = new Agent({
    model: anthropic("claude-sonnet-5"),
    tools: { read, grep, bash },
    instructions: `You are a trust & safety content moderator. Analyze content against policy guidelines.
Classify risk level and policy category with high precision. Flag specific segments that violate policy.
When confidence is below 0.85 or the content is ambiguous, mark for human review.`,
});
const actionAgent = new Agent({
    model: anthropic("claude-sonnet-5"),
    tools: { read, bash },
    instructions: `You are a trust & safety action handler. Based on moderation results, take the appropriate
policy action: approve safe content, apply modifications for borderline cases, reject clear violations,
or escalate edge cases with detailed context for human reviewers.`,
});
export default smithers((ctx) => {
    return (<Workflow name="trust-safety-moderator">
      <Sequence>
        {/* Content intake — normalize and extract metadata */}
        <Task id="intake" output={outputs.intake}>
          <IntakePrompt content={ctx.input.content ?? ""} source={ctx.input.source ?? "user_submission"} authorId={ctx.input.authorId ?? "anonymous"}/>
        </Task>

        {/* Moderator agent — classify risk and policy */}
        <Task id="moderate" output={outputs.moderation} agent={moderator} deps={{ intake: outputs.intake }}>
          {(deps) => <ModeratePrompt contentId={deps.intake.contentId} contentType={deps.intake.contentType} rawText={deps.intake.rawText} policies={ctx.input.policies ?? "default"}/>}
        </Task>

        {/* Policy-specific action or escalation */}
        <Task id="action" output={outputs.action} agent={actionAgent} deps={{ moderate: outputs.moderation, intake: outputs.intake }}>
          {(deps) => <ActionPrompt contentId={deps.moderate.contentId} riskLevel={deps.moderate.riskLevel} policyClass={deps.moderate.policyClass} confidence={deps.moderate.confidence} reasoning={deps.moderate.reasoning} flaggedSegments={deps.moderate.flaggedSegments} needsHumanReview={deps.moderate.needsHumanReview} rawText={deps.intake.rawText}/>}
        </Task>
      </Sequence>
    </Workflow>);
});
