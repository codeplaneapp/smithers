// @ts-nocheck
/**
 * <CalendarNegotiatorWithApproval> - Propose meeting slots and write only after approval.
 *
 * Pattern: email/request parse -> availability and policy checks -> slot ranking ->
 * reply draft -> approval gate -> idempotent calendar and email writes.
 * Use cases: scheduling assistants, executive admin automation, room booking,
 * customer meeting coordination.
 *
 * Smithers implementation: all write-capable actions sit behind an Approval
 * gate, and the calendar mutation output carries an idempotency key for safe
 * retry and resume.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ParseRequestPrompt from "./prompts/calendar-negotiator-with-approval/parse-request.mdx";
import CheckAvailabilityPrompt from "./prompts/calendar-negotiator-with-approval/check-availability.mdx";
import CheckPolicyPrompt from "./prompts/calendar-negotiator-with-approval/check-policy.mdx";
import RankSlotsPrompt from "./prompts/calendar-negotiator-with-approval/rank-slots.mdx";
import DraftReplyPrompt from "./prompts/calendar-negotiator-with-approval/draft-reply.mdx";
import CreateEventPrompt from "./prompts/calendar-negotiator-with-approval/create-event.mdx";
import SendReplyPrompt from "./prompts/calendar-negotiator-with-approval/send-reply.mdx";

const slotSchema = z.object({
    start: z.string(),
    end: z.string(),
    timezone: z.string(),
    conflicts: z.array(z.string()),
    score: z.number().min(0).max(1),
});

const scheduleRequestSchema = z.object({
    title: z.string(),
    attendees: z.array(z.string().email()),
    durationMinutes: z.number(),
    timeWindow: z.string(),
    timezone: z.string(),
    constraints: z.array(z.string()),
});

const availabilitySchema = z.object({
    source: z.string(),
    slots: z.array(slotSchema),
    unavailableReasons: z.array(z.string()),
});

const rankedSlotsSchema = z.object({
    slots: z.array(slotSchema),
    rankingExplanation: z.string(),
});

const replySchema = z.object({
    subject: z.string(),
    body: z.string(),
    proposedSlots: z.array(slotSchema),
    requiresApproval: z.boolean(),
});

const approvalSchema = z.object({
    approved: z.boolean(),
    reviewer: z.string(),
    note: z.string(),
});

const calendarMutationSchema = z.object({
    eventId: z.string(),
    status: z.enum(["created", "skipped", "failed"]),
    idempotencyKey: z.string(),
    summary: z.string(),
});

const emailResultSchema = z.object({
    messageId: z.string(),
    status: z.enum(["sent", "skipped", "failed"]),
    idempotencyKey: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
    scheduleRequest: scheduleRequestSchema,
    availability: availabilitySchema,
    rankedSlots: rankedSlotsSchema,
    reply: replySchema,
    approval: approvalSchema,
    calendarMutation: calendarMutationSchema,
    emailResult: emailResultSchema,
});

const parserAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are a scheduling request parser. Extract title, attendees,
duration, time window, timezone, and constraints from email or chat messages.`,
});

const calendarAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read },
    instructions: `You are a calendar availability agent. Check free/busy data,
room calendars, and supplied availability fixtures. Return candidate slots with conflicts.`,
});

const policyAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are a scheduling policy checker. Enforce work hours, buffers,
focus blocks, meeting-free days, and "never create events without approval" rules.`,
});

const replyAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are an executive assistant. Rank candidate slots and draft a
clear, polite reply that proposes the best options without committing to a write.`,
});

const writerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read },
    instructions: `You are a calendar/email writer. Only act after approval. Use the
provided idempotency key to avoid duplicate events or duplicate replies.`,
});

export default smithers((ctx) => {
    const request = ctx.outputMaybe("scheduleRequest", { nodeId: "parse-request" });
    const reply = ctx.outputMaybe("reply", { nodeId: "draft-reply" });
    const approval = ctx.outputMaybe("approval", { nodeId: "approve-calendar-write" });
    const approved = approval?.approved === true;
    const idempotencyKey = ctx.input.idempotencyKey ?? `calendar-${ctx.input.threadId ?? "manual"}`;

    return (
        <Workflow name="calendar-negotiator-with-approval">
            <Sequence>
                <Task id="parse-request" output={outputs.scheduleRequest} agent={parserAgent}>
                    <ParseRequestPrompt
                        message={ctx.input.message ?? "Could we find 30 minutes next week, ideally Tue or Wed afternoon ET, to review the renewal?"}
                        defaults={ctx.input.defaults ?? { timezone: "America/New_York", durationMinutes: 30 }}
                    />
                </Task>

                <Parallel maxConcurrency={3}>
                    <Task id="check-organizer-calendar" output={outputs.availability} agent={calendarAgent}>
                        <CheckAvailabilityPrompt source="organizer" request={request} calendars={ctx.input.organizerCalendars ?? []} />
                    </Task>
                    <Task id="check-room-calendar" output={outputs.availability} agent={calendarAgent}>
                        <CheckAvailabilityPrompt source="room" request={request} calendars={ctx.input.roomCalendars ?? []} />
                    </Task>
                    <Task id="check-work-hours" output={outputs.availability} agent={policyAgent}>
                        <CheckPolicyPrompt request={request} policy={ctx.input.policy ?? "No meetings before 9:30 AM; keep 15-minute buffers; require approval before writes."} />
                    </Task>
                </Parallel>

                <Task id="rank-slots" output={outputs.rankedSlots} agent={replyAgent}>
                    <RankSlotsPrompt request={request} availability={ctx.outputs.availability ?? []} preferences={ctx.input.preferences ?? []} />
                </Task>

                <Task id="draft-reply" output={outputs.reply} agent={replyAgent}>
                    <DraftReplyPrompt
                        request={request}
                        rankedSlots={ctx.outputMaybe("rankedSlots", { nodeId: "rank-slots" })}
                        sender={ctx.input.sender ?? "me"}
                    />
                </Task>

                <Approval
                    id="approve-calendar-write"
                    output={outputs.approval}
                    request={{
                        title: "Approve calendar write",
                        summary: `Draft reply proposes ${(reply?.proposedSlots ?? []).length} slot(s). Calendar and email writes will use idempotency key ${idempotencyKey}.`,
                    }}
                />

                <Branch
                    if={approved}
                    then={
                        <Sequence>
                            <Task id="create-event" output={outputs.calendarMutation} agent={writerAgent}>
                                <CreateEventPrompt request={request} reply={reply} idempotencyKey={idempotencyKey} />
                            </Task>
                            <Task id="send-reply" output={outputs.emailResult} agent={writerAgent}>
                                <SendReplyPrompt reply={reply} threadId={ctx.input.threadId ?? "manual"} idempotencyKey={idempotencyKey} />
                            </Task>
                        </Sequence>
                    }
                    else={null}
                />
            </Sequence>
        </Workflow>
    );
});
