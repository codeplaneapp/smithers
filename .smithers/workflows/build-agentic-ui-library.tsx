// smithers-display-name: Agentic UI Library Program
/** @jsxImportSource smthrs */
import {
  ClaudeCodeAgent,
  MergeQueue,
  OpenCodeAgent,
  Parallel,
  Sequence,
  Task,
  UI,
  Worktree,
  createSmithers,
} from "smthrs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Build the complete agentic UI component program: transport-neutral components
// in packages/ui, Gateway bindings in packages/gateway-ui, then selective
// adoption in the Multi app. Parallel isolated worktree lanes implement with
// OpenCode/Kimi 3; Fable and Sol alternate as independent reviewers (both on
// critical shared-surface lanes); a serialized integration lane owns barrels,
// composed CSS, provenance, manifests, lockfiles, and docs.

export const MULTI_ROOT = "/Users/williamcory/multi";

// ── Agents ──────────────────────────────────────────────────────────────────
// User directive: OpenCode with Kimi 3 implements; Fable and Sol review.
// Fallbacks exist only for provider failure (preflight/mid-attempt), so a dead
// CLI never burns the lane's attempt budget.
const kimiImplement = [new OpenCodeAgent({ model: "kimi-for-coding/k3" }), providers.claudeSonnet];
const kimiImplementMulti = [
  new OpenCodeAgent({ model: "kimi-for-coding/k3", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
];
const fableChain = [providers.claude, providers.claudeOpus];
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const fableChainMulti = [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })];
const solChainMulti = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true, cwd: MULTI_ROOT },
  [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })],
);
const validateChain = [providers.claudeSonnet, providers.claude];
const validateChainMulti = [
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT }),
];
const mergeChain = [providers.claudeSonnet, providers.claude];

// ── Lanes ───────────────────────────────────────────────────────────────────
export const laneIds = [
  "conversation-foundation",
  "prompt-attachments",
  "reasoning-tools",
  "plans-tasks-queues",
  "approvals-checkpoints",
  "sources-citations",
  "agent-identity-context",
  "coding-artifacts",
  "sandbox-previews",
  "workflow-canvas",
  "integration",
  "adopt-chat",
  "adopt-gateway",
  "adopt-product",
] as const;
const laneIdSchema = z.enum(laneIds);
type LaneId = (typeof laneIds)[number];
type Seat = "fable" | "sol";

type Lane = {
  id: LaneId;
  title: string;
  seats: Seat[];
  components: string[];
  spec: string;
};

// Voice surfaces are explicitly out of scope unless a shipped product flow
// needs them; both auditors must endorse keeping them deferred.
export const EXPLICIT_DEFERRALS = [
  "AudioPlayer",
  "Persona",
  "MicSelector",
  "VoiceSelector",
  "SpeechInput (beyond Multi's existing dictation)",
  "Full voice-agent mode",
];

export const LANES: Lane[] = [
  {
    id: "conversation-foundation",
    title: "Conversation foundation: Message/Bubble/Branch/Transcript + MessageScroller upgrade",
    seats: ["fable", "sol"],
    components: [
      "Message",
      "MessageAvatar",
      "MessageHeader",
      "MessageContent",
      "MessageFooter",
      "MessageActions",
      "MessageGroup",
      "MessageBranch",
      "MessageBranchSelector",
      "MessageBranchPrevious",
      "MessageBranchNext",
      "MessageBranchPage",
      "Bubble",
      "BubbleContent",
      "BubbleActions",
      "BubbleReactions",
      "ChatTranscript",
      "CompactGroup",
      "ConversationCheckpoint",
      "Marker",
      "Shimmer",
      "MessageScroller",
    ],
    spec: [
      "Complete or add in packages/ui/src/chat/: the Message compound family (Message, MessageAvatar, MessageHeader, MessageContent, MessageFooter, MessageActions, MessageGroup), the MessageBranch family (MessageBranch, MessageBranchSelector, MessageBranchPrevious, MessageBranchNext, MessageBranchPage) for alternate-response navigation, Bubble compound anatomy (BubbleContent, BubbleActions, BubbleReactions on the existing Bubble), CompactGroup (collapsed runs of compacted turns), ConversationCheckpoint (a labeled durable-checkpoint row), and keep/extend Marker, Shimmer, and the scroll-fade behavior.",
      "Upgrade MessageScroller to a Provider/Scroller/Viewport/Content/Item/Button compound anatomy with: stable message IDs, turn anchoring, previous-item peek, streaming follow behavior, saved-transcript restoration, prepend-history position preservation, jump-to-message, jump-to-latest, visibility tracking, pay-for-use scroll subscriptions, keyboard-accessible region + live-log semantics, and content-visibility optimization for long transcripts. The existing MessageScroller/ChatTranscript props and streaming defaults MUST keep working unchanged (compat surface stays green in the existing tests).",
      "ChatTranscript composes the upgraded scroller internally without breaking its current props.",
    ].join("\n"),
  },
  {
    id: "prompt-attachments",
    title: "Prompt input and attachment system",
    seats: ["fable"],
    components: [
      "PromptInput",
      "PromptInputHeader",
      "PromptInputBody",
      "PromptInputTextarea",
      "PromptInputFooter",
      "PromptInputTools",
      "PromptInputButton",
      "PromptInputSubmit",
      "PromptInputStop",
      "PromptInputActionMenu",
      "PromptInputActionAddAttachments",
      "Attachment",
      "AttachmentMedia",
      "AttachmentContent",
      "AttachmentTitle",
      "AttachmentDescription",
      "AttachmentActions",
      "AttachmentAction",
      "AttachmentTrigger",
      "AttachmentGroup",
      "AttachmentPreview",
      "AttachmentRemove",
    ],
    spec: [
      "Add in packages/ui/src/chat/ (or a prompt/ sibling per the frozen spec): the PromptInput compound family (PromptInput, PromptInputHeader, PromptInputBody, PromptInputTextarea, PromptInputFooter, PromptInputTools, PromptInputButton, PromptInputSubmit, PromptInputStop, PromptInputActionMenu, PromptInputActionAddAttachments) and the Attachment compound family (extend the existing Attachment with AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger, AttachmentGroup, AttachmentPreview, AttachmentRemove).",
      "Support: controlled and uncontrolled input, submit and stop states, keyboard submission (Enter/mod+Enter), multiline input, uploading/processing/error/completed attachment states, numeric and indeterminate progress, images/files/screenshots, model/agent selector slots, queued prompts, and mobile + keyboard accessibility.",
      "Keep the existing lightweight ChatComposer API working as a convenience composition over PromptInput.",
    ].join("\n"),
  },
  {
    id: "reasoning-tools",
    title: "Agent reasoning and tool activity",
    seats: ["sol"],
    components: [
      "Reasoning",
      "ReasoningTrigger",
      "ReasoningContent",
      "ReasoningSummary",
      "ChainOfThought",
      "ChainOfThoughtStep",
      "ToolCall",
      "ToolCallHeader",
      "ToolCallInput",
      "ToolCallOutput",
      "ToolCallError",
      "ToolCallApproval",
      "AgentOutput",
      "MessageResponse",
      "CodeBlock",
      "CodeBlockHeader",
      "CodeBlockFilename",
      "CodeBlockGroup",
      "CodeBlockTabs",
    ],
    spec: [
      "Complete in packages/ui/src/agentic/: give the existing Reasoning a Trigger/Content compound anatomy plus a ReasoningSummary presentation ('Thinking' is presentation text over provider-safe reasoning summaries; the API must NOT assume raw private chain-of-thought is available and must not encourage disclosing it). Extend ChainOfThought with an explicit ChainOfThoughtStep. Extend ToolCall with ToolCallHeader, ToolCallInput, ToolCallOutput, ToolCallError, ToolCallApproval compound parts. Extend AgentOutput and MessageResponse as needed. Add CodeBlock compound additions: CodeBlockHeader, CodeBlockFilename, CodeBlockGroup, CodeBlockTabs.",
      "Support: streaming, partial JSON tool input, image results, code results, errors, duration display, disclosure state, and approval-request presentation.",
    ].join("\n"),
  },
  {
    id: "plans-tasks-queues",
    title: "Plans, tasks, queues and activity timeline",
    seats: ["fable"],
    components: [
      "Plan",
      "PlanHeader",
      "PlanTitle",
      "PlanDescription",
      "PlanContent",
      "PlanStep",
      "PlanAction",
      "PlanFooter",
      "AgentTask",
      "TaskTrigger",
      "TaskContent",
      "TaskItem",
      "TaskItemFile",
      "TaskGroup",
      "Queue",
      "QueueSection",
      "QueueSectionTrigger",
      "QueueSectionLabel",
      "QueueSectionContent",
      "QueueList",
      "QueueItem",
      "QueueItemIndicator",
      "QueueItemContent",
      "QueueItemDescription",
      "ActivityTimeline",
      "ActivityItem",
      "ActivityGroup",
    ],
    spec: [
      "Complete in packages/ui/src/agentic/: Plan compound anatomy (PlanHeader, PlanTitle, PlanDescription, PlanContent, PlanStep, PlanAction, PlanFooter on the existing Plan), a collapsible Task unit (exported name resolves the collision with any existing export — the program calls it Task; AgentTask is an acceptable exported name if Task collides, the design freeze decides) with TaskTrigger, TaskContent, TaskItem (extend existing), TaskItemFile, TaskGroup. Add the Queue family (Queue, QueueSection, QueueSectionTrigger, QueueSectionLabel, QueueSectionContent, QueueList, QueueItem, QueueItemIndicator, QueueItemContent, QueueItemDescription). Add ActivityTimeline with ActivityItem and ActivityGroup.",
      "Model states: pending, running, completed, failed, skipped, blocked, approval-waiting, retrying, cancelled — mapped through the shared status vocabulary in src/status.ts (extend it rather than inventing a parallel one).",
      "ActivityTimeline item kinds must represent: agent messages, reasoning summaries, tool calls, approvals, retries, handoffs, delegation, checkpoints, signals, outputs, and failures.",
    ].join("\n"),
  },
  {
    id: "approvals-checkpoints",
    title: "Approvals and durable checkpoints (+ gateway-ui bindings)",
    seats: ["sol"],
    components: [
      "Confirmation",
      "ConfirmationTitle",
      "ConfirmationRequest",
      "ConfirmationAccepted",
      "ConfirmationRejected",
      "ConfirmationActions",
      "ConfirmationAction",
      "ApprovalCard",
      "ApprovalRisk",
      "ApprovalResources",
      "ApprovalNote",
      "Checkpoint",
      "CheckpointIcon",
      "CheckpointMetadata",
      "CheckpointTrigger",
      "CheckpointActions",
    ],
    spec: [
      "Add in packages/ui/src/agentic/ (or approvals/ per the frozen spec): the Confirmation family (Confirmation, ConfirmationTitle, ConfirmationRequest, ConfirmationAccepted, ConfirmationRejected, ConfirmationActions, ConfirmationAction), ApprovalCard with ApprovalRisk, ApprovalResources, ApprovalNote (note/editor slots, risk levels, proposed actions, affected resources), and the Checkpoint family (Checkpoint, CheckpointIcon, CheckpointMetadata, CheckpointTrigger, CheckpointActions).",
      "Approval states must cover: synchronizing, requested, approving, denying, approved, denied, expired, unavailable, failed-submission.",
      "Checkpoint actions must support the Smithers concepts: restore, fork, replay, rewind, return-to-live.",
      "Then add Gateway-connected wrappers in packages/gateway-ui (NEW files only, composed over smthrs/gateway-react hooks + these base components): an approval wrapper wired to useGatewayApprovals/submitApproval (decision is a nested {approved} object) and a checkpoint wrapper wired to the snapshot/rewind actions. Do not modify existing gateway-ui exports' behavior; the integration lane wires barrels.",
    ].join("\n"),
  },
  {
    id: "sources-citations",
    title: "Sources, citations and contextual actions",
    seats: ["fable"],
    components: [
      "Sources",
      "SourcesTrigger",
      "SourcesContent",
      "Source",
      "InlineCitation",
      "CitationCard",
      "CitationCarousel",
      "CitationQuote",
      "Suggestion",
      "SuggestionGroup",
      "OpenInChat",
    ],
    spec: [
      "Complete in packages/ui/src/agentic/: give the existing Sources a Trigger/Content/Source compound anatomy. Extend InlineCitation with CitationCard, CitationCarousel (keyboard-accessible multi-source preview per claim), and CitationQuote. Add Suggestion and SuggestionGroup (prompt suggestion chips). Add OpenInChat: an 'Ask Smithers about this' action affordance for files, diffs, issues, tests, runs, logs, errors and artifacts (props-driven: subject descriptor in, onOpen callback out; no routing/transport in the base package).",
      "Support: safe URLs only (reuse safeMarkdownHref), favicons where available with text fallback, source title/domain/excerpt, keyboard-accessible citation previews, multiple sources per claim.",
    ].join("\n"),
  },
  {
    id: "agent-identity-context",
    title: "Agent identity, models and context usage",
    seats: ["sol"],
    components: [
      "AgentDefinition",
      "AgentHeader",
      "AgentContent",
      "AgentInstructions",
      "AgentTools",
      "AgentTool",
      "AgentOutputSchema",
      "AgentCard",
      "ModelSelector",
      "ModelSelectorTrigger",
      "ModelSelectorContent",
      "ModelSelectorGroup",
      "ModelSelectorItem",
      "ModelBadge",
      "ProviderBadge",
      "ContextUsage",
      "ContextTrigger",
      "ContextContent",
      "ContextContentHeader",
      "ContextContentBody",
      "ContextContentFooter",
      "ContextInputUsage",
      "ContextOutputUsage",
      "ContextReasoningUsage",
      "ContextCacheUsage",
    ],
    spec: [
      "Add in packages/ui/src/agentic/ (or agents/ per the frozen spec): an Agent presentation family (the program calls the root Agent; AgentDefinition is an acceptable exported name if Agent is too collision-prone, the design freeze decides) with AgentHeader, AgentContent, AgentInstructions, AgentTools, AgentTool, AgentOutputSchema, plus AgentCard. Add ModelSelector compound anatomy (ModelSelector, ModelSelectorTrigger, ModelSelectorContent, ModelSelectorGroup, ModelSelectorItem — compose the existing Select primitives), ModelBadge and ProviderBadge. Add the ContextUsage family (ContextUsage, ContextTrigger, ContextContent, ContextContentHeader, ContextContentBody, ContextContentFooter, ContextInputUsage, ContextOutputUsage, ContextReasoningUsage, ContextCacheUsage).",
      "Support: provider and model identity, availability and authentication posture, instructions, tool descriptions and input schemas, permissions, output schema, context-window percentage, input/output/reasoning/cache token counts, token limits, optional cost values, and honest unavailable/unknown states.",
      "Do NOT bundle a pricing database into the base package: cost arrives via props (or a later separate adapter).",
    ].join("\n"),
  },
  {
    id: "coding-artifacts",
    title: "Coding artifacts and diagnostics",
    seats: ["fable"],
    components: [
      "Artifact",
      "ArtifactHeader",
      "ArtifactTitle",
      "ArtifactDescription",
      "ArtifactActions",
      "ArtifactAction",
      "ArtifactContent",
      "ArtifactClose",
      "Snippet",
      "PackageInfo",
      "SchemaDisplay",
      "StackTrace",
      "StackFrame",
      "TestResults",
      "TestResultsHeader",
      "TestResultsSummary",
      "TestResultsDuration",
      "TestResultsProgress",
      "TestResultsContent",
      "TestSuite",
      "TestSuiteName",
      "TestSuiteStats",
      "TestSuiteContent",
      "TestRow",
      "TestStatus",
      "TestName",
      "Commit",
      "CommitHeader",
      "CommitAuthor",
      "CommitInfo",
      "CommitMessage",
      "CommitMetadata",
      "CommitHash",
      "CommitTimestamp",
      "CommitActions",
      "CommitFiles",
      "CommitFile",
      "CommitFileStatus",
      "CommitFilePath",
      "ChangeSummary",
      "EnvironmentVariables",
      "EnvironmentVariable",
      "SecretField",
    ],
    spec: [
      "Add in packages/ui/src/agentic/ (or artifacts/ per the frozen spec): the Artifact family (Artifact, ArtifactHeader, ArtifactTitle, ArtifactDescription, ArtifactActions, ArtifactAction, ArtifactContent, ArtifactClose), Snippet, PackageInfo, SchemaDisplay (JSON-schema rendering), StackTrace + StackFrame, the TestResults family (TestResults, TestResultsHeader, TestResultsSummary, TestResultsDuration, TestResultsProgress, TestResultsContent, TestSuite, TestSuiteName, TestSuiteStats, TestSuiteContent, a per-test row — the program calls it Test; TestRow is an acceptable exported name if Test collides, the design freeze decides — with TestStatus and TestName), the Commit family (Commit, CommitHeader, CommitAuthor, CommitInfo, CommitMessage, CommitMetadata, CommitHash, CommitTimestamp, CommitActions, CommitFiles, CommitFile, CommitFileStatus, CommitFilePath), ChangeSummary (additions/deletions/changed-file rollup, git AND jj terminology), EnvironmentVariables + EnvironmentVariable, and SecretField (redacted display with reveal affordance; never renders the secret into the DOM while masked).",
      "COMPOSE the existing Smithers components rather than rebuilding: CodeBlock, Markdown, FileTree, DiffHunks, the PierreDiffView adapter, and the Terminal adapter.",
      "Support: streaming/running tests, failures, skipped tests, durations, stack frames, changed-file status, additions/deletions, schema rendering, and redacted secrets.",
    ].join("\n"),
  },
  {
    id: "sandbox-previews",
    title: "Sandbox, web previews and generated UI",
    seats: ["sol"],
    components: [
      "Sandbox",
      "SandboxHeader",
      "SandboxStatus",
      "SandboxActions",
      "SandboxContent",
      "WebPreview",
      "WebPreviewToolbar",
      "WebPreviewAddress",
      "WebPreviewContent",
      "JSXPreview",
    ],
    spec: [
      "Add in packages/ui/src/agentic/ (or sandbox/ per the frozen spec): the Sandbox family (Sandbox, SandboxHeader, SandboxStatus, SandboxActions, SandboxContent) modeling provisioning/ready/disconnected/suspended/failed/destroyed states with retry/reconnect actions and workspace/repository identity. Add WebPreview (WebPreview, WebPreviewToolbar, WebPreviewAddress, WebPreviewContent) with preview URLs, sandboxed iframe boundaries (sandbox attribute locked down, no allow-same-origin+allow-scripts combination), loading and navigation states. Add JSXPreview (render a provided React node inside an inert preview frame with an honest unavailable state). Reuse attachment/tool-output image + media preview primitives where the frozen spec requires them.",
      "Honest unavailable states everywhere; NO fake execution and NO fake preview results.",
    ].join("\n"),
  },
  {
    id: "workflow-canvas",
    title: "Workflow canvas anatomy (renderer-neutral)",
    seats: ["fable", "sol"],
    components: [
      "WorkflowCanvas",
      "WorkflowNode",
      "WorkflowNodeHeader",
      "WorkflowNodeContent",
      "WorkflowNodeStatus",
      "WorkflowEdge",
      "WorkflowConnection",
      "WorkflowControls",
      "WorkflowPanel",
      "WorkflowToolbar",
      "WorkflowMinimap",
    ],
    spec: [
      "Add lightweight, props-driven canvas anatomy in packages/ui/src/agentic/ (or canvas/ per the frozen spec): WorkflowCanvas, WorkflowNode, WorkflowNodeHeader, WorkflowNodeContent, WorkflowNodeStatus, WorkflowEdge, WorkflowConnection, WorkflowControls, WorkflowPanel, WorkflowToolbar, and a WorkflowMinimap seam.",
      "The base anatomy is renderer-neutral: @xyflow/react must NOT enter the packages/ui base barrel or dependencies. The actual ReactFlow renderer stays behind an adapter or in packages/gateway-ui. INTEGRATE with the existing gateway-ui WorkflowGraph (SmithersTaskNode, workflowToFlow, workflowGraphCss) rather than creating a competing graph model: the anatomy components become the visual language WorkflowGraph's node/edge renderers compose (change gateway-ui only in NEW files or minimal, behavior-preserving edits; the integration lane wires barrels).",
    ].join("\n"),
  },
];

export const ADOPTION_LANES: Lane[] = [
  {
    id: "adopt-chat",
    title: "Multi chat adoption: transcript + composer on shared components",
    seats: ["fable", "sol"],
    components: [
      "Message",
      "MessageScroller",
      "Bubble",
      "MessageBranch",
      "PromptInput",
      "AttachmentGroup",
      "Marker",
      "Shimmer",
      "SuggestionGroup",
      "Reasoning",
      "ToolCall",
      "Sources",
      "CompactGroup",
    ],
    spec: [
      `Refactor Multi's transcript and composer (${MULTI_ROOT}/src/chat/ChatTranscript.tsx, ComposingCard.tsx and their collaborators) to consume the shared components from @smthrs/ui: Message family, MessageScroller, Bubble, MessageBranch, PromptInput, AttachmentGroup, Marker, Shimmer, SuggestionGroup, Reasoning, ToolCall, Sources, CompactGroup.`,
      "PRESERVE, verified by the existing tests: Zustand store ownership (zero new useState/useEffect in product code), ref-registered imperative handles, transcript persistence, scope compaction, inline live cards, pair co-composition, slash commands, dictation, streaming behavior, and honest pending/error states.",
    ].join("\n"),
  },
  {
    id: "adopt-gateway",
    title: "Multi gateway/run adoption: structured node output rendering",
    seats: ["sol"],
    components: [
      "AgentOutput",
      "ActivityTimeline",
      "Plan",
      "TaskContent",
      "Queue",
      "Artifact",
      "TestResults",
      "StackTrace",
      "CodeBlock",
      "SchemaDisplay",
      "Confirmation",
      "Checkpoint",
      "ContextUsage",
    ],
    spec: [
      `Refactor Multi's gateway node detail and run inspection (${MULTI_ROOT}/src/gateway/GatewayNodeDetail.tsx, GatewayRunInspector.tsx, ${MULTI_ROOT}/src/runs/NodeInspector.tsx, RunInspector.tsx and collaborators) to render structured output through the shared components: AgentOutput, ActivityTimeline, Plan/Task/Queue, Artifact, TestResults, StackTrace, CodeBlock, SchemaDisplay, Confirmation, Checkpoint, ContextUsage.`,
      "Replace raw JSON output whenever a recognized structured renderer exists; ALWAYS retain a raw/source fallback view.",
    ].join("\n"),
  },
  {
    id: "adopt-product",
    title: "Multi product-surface adoption (selective)",
    seats: ["fable"],
    components: [
      "AgentCard",
      "ModelSelector",
      "ProviderBadge",
      "Confirmation",
      "ApprovalCard",
      "CheckpointActions",
      "Commit",
      "ChangeSummary",
      "Artifact",
      "OpenInChat",
      "TestResults",
      "EnvironmentVariables",
      "SecretField",
      "Sandbox",
      "WorkflowCanvas",
    ],
    spec: [
      "Adopt shared components in Multi's product surfaces WHERE shared behavior and accessibility remove duplicated product code (do NOT migrate every screen mechanically): agent registry (AgentCard, ModelSelector, ProviderBadge), approvals (Confirmation, ApprovalCard), timeline (Checkpoint actions), VCS/files (Commit, ChangeSummary, Artifact, OpenInChat), evals (TestResults), BYOK/environment (EnvironmentVariables, SecretField), sandbox/terminal (Sandbox + status anatomy), flow editor/diagram (workflow canvas anatomy), inline concierge cards (shared Card/Artifact primitives).",
      "Prioritize by duplication removed; record what you deliberately skipped and why in the summary.",
    ].join("\n"),
  },
];

const ALL_LANES = [...LANES, ...ADOPTION_LANES];
export const plannedComponentTotal = ALL_LANES.reduce((sum, lane) => sum + lane.components.length, 0);

// ── Schemas (agui-prefixed: output tables are shared by name across the
// workspace DB; required/min-constrained fields make an empty repaired `{}`
// fail validation instead of persisting an all-NULL row) ────────────────────
export const researchSchema = z.object({
  phase: z.literal("research"),
  summary: z.string().min(200),
  upstreamNotes: z.string().min(600),
  sourcesConsulted: z.array(z.string()).min(2),
});
export const specSchema = z.object({
  specMarkdown: z.string().min(1200),
  componentApis: z.string().min(600),
  integrationContract: z.string().min(300),
  risks: z.array(z.string()).default([]),
});
export const specReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().min(10),
});
export const implSchema = z.object({
  laneId: laneIdSchema,
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
  testsAddedOrUpdated: z.array(z.string()).default([]),
  componentsImplemented: z.array(z.string()).default([]),
  componentsDeferred: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  commandsRun: z.array(z.string()).default([]),
});
export const validationSchema = z.object({
  laneId: laneIdSchema,
  allPassed: z.boolean(),
  diffNonEmpty: z.boolean(),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
export const reviewSchema = z.object({
  laneId: laneIdSchema,
  seat: z.enum(["fable", "sol"]),
  reviewer: z.string().min(3),
  approved: z.boolean(),
  feedback: z.string().min(10),
  deferralsEndorsed: z.boolean().default(false),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]),
        title: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
});
export const laneResultSchema = z.object({
  laneId: laneIdSchema,
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  lgtm: z.boolean(),
  exhausted: z.boolean(),
  attempts: z.number().int().min(0),
  summary: z.string().min(10),
  filesChanged: z.array(z.string()).default([]),
  componentsImplemented: z.array(z.string()).default([]),
  componentsDeferred: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  seatVerdicts: z.array(z.object({ seat: z.string(), approved: z.boolean(), reviewer: z.string() })).default([]),
});
export const mergeSchema = z.object({
  laneId: laneIdSchema,
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
  commandsRun: z.array(z.string()).default([]),
});
export const ciSchema = z.object({
  scope: z.enum(["smithers", "multi"]),
  allPassed: z.boolean(),
  summary: z.string().min(5),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
      }),
    )
    .default([]),
});
export const ciFixSchema = z.object({
  scope: z.enum(["smithers", "multi"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
export const auditSchema = z.object({
  seat: z.enum(["fable", "sol"]),
  complete: z.boolean(),
  deferralsEndorsed: z.boolean(),
  summary: z.string().min(100),
  coverageMatrix: z
    .array(
      z.object({
        component: z.string(),
        lane: z.string(),
        state: z.enum(["planned", "implemented", "reviewed", "integrated", "adopted", "deferred"]),
        note: z.string().nullable().default(null),
      }),
    )
    .default([]),
  followUps: z.array(z.string()).default([]),
});
export const manifestSchema = z.object({
  programTitle: z.string().min(5),
  plannedComponents: z.number().int().min(1),
  lanes: z
    .array(
      z.object({
        laneId: laneIdSchema,
        title: z.string(),
        kind: z.enum(["component", "integration", "adoption"]),
        implementModel: z.string(),
        reviewSeats: z.array(z.string()),
        components: z.array(z.string()),
      }),
    )
    .min(1),
});
export const finalReportSchema = z.object({
  success: z.boolean(),
  lanesLgtm: z.number().int().min(0),
  lanesTotal: z.number().int().min(0),
  integrationDone: z.boolean(),
  adoptionDone: z.boolean(),
  smithersCiGreen: z.boolean(),
  multiCiGreen: z.boolean(),
  auditsComplete: z.boolean(),
  summary: z.string().min(20),
});

export const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(6).default(3),
  perLaneIterations: z.number().int().min(1).max(3).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  aguiResearch: researchSchema,
  aguiSpec: specSchema,
  aguiSpecReview: specReviewSchema,
  aguiImpl: implSchema,
  aguiValidation: validationSchema,
  aguiReview: reviewSchema,
  aguiLaneResult: laneResultSchema,
  aguiMerge: mergeSchema,
  aguiCi: ciSchema,
  aguiCiFix: ciFixSchema,
  aguiAudit: auditSchema,
  aguiManifest: manifestSchema,
  aguiFinal: finalReportSchema,
});

type RawRow = Record<string, unknown>;

// ── Row helpers (proven shapes from bulletproof-ui / studio-parity-swarm) ───
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}

export function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}

function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}

function latestRaw(rows: RawRow[], nodeId: string): RawRow | undefined {
  return rows
    .filter((row) => baseNodeId(row) === nodeId)
    .reduce<RawRow | undefined>((best, row) => {
      if (!best) return row;
      const current = rowVersion(row);
      const previous = rowVersion(best);
      return current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]) ? row : best;
    }, undefined);
}

function sameVersion(left: RawRow | undefined, right: RawRow | undefined): boolean {
  if (!left || !right) return false;
  const a = rowVersion(left);
  const b = rowVersion(right);
  return a[0] === b[0] && a[1] === b[1];
}

// ── Lane state ──────────────────────────────────────────────────────────────
export function laneState(ctx: any, lane: Lane, maxIterations: number, nodePrefix = `lane-${lane.id}`) {
  const implRows = rawRows(ctx, "aguiImpl").filter(
    (row) => baseNodeId(row) === `${nodePrefix}-implement` && row.laneId === lane.id,
  );
  const implementation = latestRaw(implRows, `${nodePrefix}-implement`);
  const validation = latestRaw(
    rawRows(ctx, "aguiValidation").filter((row) => row.laneId === lane.id),
    `${nodePrefix}-validate`,
  );
  const validationCurrent = sameVersion(implementation, validation);
  const reviews = lane.seats.map((seat) => {
    const review = latestRaw(
      rawRows(ctx, "aguiReview").filter((row) => row.laneId === lane.id && row.seat === seat),
      `${nodePrefix}-review-${seat}`,
    );
    return { seat, review, current: validationCurrent && sameVersion(validation, review) };
  });
  const reviewsCurrent = reviews.every((entry) => entry.current);
  const reviewsApproved = reviewsCurrent && reviews.every((entry) => entry.review?.approved === true);
  const done =
    implementation?.status === "implemented" &&
    validationCurrent &&
    validation?.allPassed === true &&
    validation?.diffNonEmpty === true &&
    reviewsApproved;
  const finalAttemptComplete =
    validationCurrent && (validation?.allPassed === false || validation?.diffNonEmpty === false || reviewsCurrent);
  return {
    implementation,
    validation,
    reviews,
    validationCurrent,
    reviewsCurrent,
    done,
    attempts: implRows.length,
    exhausted: !done && implRows.length >= maxIterations && finalAttemptComplete,
  };
}

function laneFeedback(state: ReturnType<typeof laneState>): string {
  const parts: string[] = [];
  if (state.implementation && state.implementation.status !== "implemented")
    parts.push(
      `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`,
    );
  if (state.validationCurrent && state.validation?.allPassed === false)
    parts.push(`VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`);
  if (state.validationCurrent && state.validation?.diffNonEmpty === false)
    parts.push(
      'VALIDATION FAILED: the lane BRANCH carries no changes (jj diff --from "fork_point(main | <branch>)" --to <branch> is empty). Your work did not land on this lane\'s branch; re-apply it here (commit with jj, explicit pathspecs).',
    );
  for (const entry of state.reviews) {
    if (entry.current && entry.review?.approved === false)
      parts.push(`REVIEW (${entry.seat} seat) NOT LGTM:\n${String(entry.review.feedback ?? "")}`);
  }
  return parts.join("\n\n");
}

// ── CI runners (compute tasks; deterministic, no agent) ─────────────────────
function runCommand(cwd: string, command: string, args: string[], timeoutMs: number) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env }, timeout: timeoutMs });
  return {
    command: [command, ...args].join(" "),
    exitCode: typeof result.status === "number" ? result.status : null,
    stdout: (result.stdout ?? "").slice(-20_000),
    stderr: (result.stderr ?? result.error?.message ?? "").slice(-20_000),
  };
}

export function runSmithersCi(cwd: string) {
  const commands: Array<[string, string[], number]> = [
    ["pnpm", ["typecheck"], 40 * 60_000],
    ["pnpm", ["-C", "packages/ui", "test"], 25 * 60_000],
    ["pnpm", ["-C", "packages/gateway-ui", "test"], 25 * 60_000],
    ["pnpm", ["lint"], 15 * 60_000],
    ["node", ["scripts/check-ui-architecture.mjs"], 10 * 60_000],
    ["node", ["scripts/check-docs.mjs"], 10 * 60_000],
    ["node", ["scripts/check-llms.mjs"], 10 * 60_000],
  ];
  const results = commands.map(([command, args, timeout]) => runCommand(cwd, command, args, timeout));
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    scope: "smithers" as const,
    allPassed: failed.length === 0,
    summary:
      failed.length === 0
        ? "Smithers gates green."
        : `${failed.length} smithers gate(s) failed: ${failed.map((f) => f.command).join("; ")}`,
    commands: results,
  };
}

export function runMultiCi(cwd: string) {
  const commands: Array<[string, string[], number]> = [
    ["pnpm", ["check:ui-architecture"], 10 * 60_000],
    ["pnpm", ["test:ui-architecture"], 10 * 60_000],
    ["pnpm", ["typecheck"], 30 * 60_000],
    ["pnpm", ["test"], 40 * 60_000],
    ["pnpm", ["build"], 30 * 60_000],
  ];
  const results = commands.map(([command, args, timeout]) => runCommand(cwd, command, args, timeout));
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    scope: "multi" as const,
    allPassed: failed.length === 0,
    summary:
      failed.length === 0
        ? "Multi gates green."
        : `${failed.length} multi gate(s) failed: ${failed.map((f) => f.command).join("; ")}`,
    commands: results,
  };
}

// ── Prompts ─────────────────────────────────────────────────────────────────
const UPSTREAM_SOURCES = [
  "https://ui.shadcn.com/docs/changelog/2026-06-chat-components (shadcn/ui official chat components)",
  "https://ui.shadcn.com/docs/components (shadcn/ui component registry)",
  "https://elements.ai-sdk.dev/ (Vercel AI Elements agent taxonomy)",
];

const HOUSE_RULES = [
  "House rules for ALL smithers-repo lanes in this program:",
  "- FIRST read packages/ui/src/README.md and packages/ui/tests/css-contract.test.ts end to end; they are the architecture contract (shadcn anatomy: data-slot attributes, compound APIs, CVA where appropriate, Radix Slot/asChild; sui-* class namespace; colors ONLY through the tokens.ts bridge; CSS shipped ONLY as TypeScript strings because Gateway bundling drops CSS imports; every component self-injects its deduplicated stylesheet).",
  "- Light, dark, reduced-motion, keyboard, and screen-reader behavior are mandatory for every component. Never hardcode a hex color; dark mode comes from tokens, not per-component code.",
  "- Base exports stay lightweight: NO new runtime dependencies in @smthrs/ui base. Heavy renderers go behind adapters/* subpaths only. Tailwind is banned; port upstream anatomy/behavior/accessibility/state models, never code.",
  "- NEVER edit shared integration files in a component lane: packages/ui/src/index.ts, packages/ui/src/uiCss.ts, packages/ui/shadcn-provenance.json, packages/gateway-ui/src/index.ts, ANY package.json, pnpm-lock.yaml, bun.lock, docs/**, or scripts/ui-architecture-baseline.json. The integration lane owns all of those. Your lane ships ONLY: component sources in your lane's directory, lane-owned *Css.ts string fragment(s) that your components self-inject (follow the frozen spec's convention), colocated tests, and a provenance FRAGMENT at packages/ui/provenance/<your-lane-id>.json following the existing fragment files there.",
  "- packages/ui stays transport-neutral: props-driven, zero imports from gateway-react/gateway-client. Gateway hook/action bindings belong in packages/gateway-ui (only the approvals-checkpoints and workflow-canvas lanes touch it, in NEW files).",
  "- Tests: real behavior, no mocks that conceal missing integration. bun + happy-dom render tests including a data-theme=dark render; where happy-dom cannot paint (canvas-like widgets), assert the parsed model. New behavior must go red before your change and green after.",
  "- Do not regress the current Smithers streaming defaults (MessageScroller/ChatTranscript existing tests stay green).",
  "- Never expose private model chain-of-thought: reasoning surfaces present provider-safe summaries and user-visible progress only.",
  "- You work in an isolated jj/git worktree. Use jj (not plain git) for VCS operations; commit ONLY your own files with explicit pathspecs (`jj commit <paths> -m ...`). Never touch this worktree's node_modules layout (no symlink repairs; if deps are broken run `pnpm install` inside YOUR worktree only).",
  "- NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/build-agentic-ui-library*.tsx (a live run imports them).",
].join("\n");

const MULTI_RULES = [
  `House rules for ALL Multi adoption lanes (repo: ${MULTI_ROOT}):`,
  `- ALL work happens in ${MULTI_ROOT} (jj-colocated). The working copy carries UNRELATED uncommitted changes (a URL-identity refactor and others) that MUST be preserved: never revert, reformat, or commit files you did not change for this lane. Use jj st / jj diff as working-copy truth; commit ONLY your own files with explicit pathspecs (\`jj commit <paths> -m ...\`); NEVER git add -A / git commit -a / git stash / git rebase / --amend.`,
  "- Multi must NOT add a direct AI Elements runtime dependency, must NOT add @smthrs/gateway-ui, and must NOT create duplicate local wrapper components around the shared ones. It already links @smthrs/ui (pnpm override link:../smithers/packages/ui); import from it directly (adapters via @smthrs/ui/adapters/* if needed).",
  "- Respect Multi's state discipline: Zustand-only React state in product code (no new useState/useEffect), stores own behavior, components render.",
  "- Real behavior and data in tests; no mocks that conceal missing integration. Honest pending/error states.",
  "- Focused verification before you report: pnpm check:ui-architecture, pnpm typecheck, and the focused tests for the files you touched.",
].join("\n");

function researchPrompt(): string {
  return [
    "Upstream research for the agentic UI component program (READ-ONLY: change no files).",
    `Inspect the CURRENT official sources before the API design is frozen:\n${UPSTREAM_SOURCES.map((s) => `- ${s}`).join("\n")}`,
    "Also read the current Smithers surface: packages/ui/src/README.md, packages/ui/src/index.ts, packages/ui/src/chat/*, packages/ui/src/agentic/*, packages/ui/src/adapters/* (subpath pattern), packages/ui/provenance/*.json (fragment convention), packages/ui/tests/css-contract.test.ts, packages/gateway-ui/src/index.ts (WorkflowGraph, ApprovalPanel, NodeOutputView).",
    "Return upstreamNotes: for each upstream registry item relevant to the program (message/branch/prompt-input/attachment/reasoning/chain-of-thought/tool/task/plan/queue/sources/inline-citation/suggestion/artifact/code-block/web-preview/sandbox/context/model-selector/confirmation/checkpoint/canvas families), capture its anatomy (slot structure), state model (incl. streaming/partial states), keyboard/accessibility behavior, and how it maps or conflicts with what already exists in packages/ui. Note exact naming collisions with current exports. Note which registry item each planned component's provenance entry should reference.",
    "Return phase=research exactly, and list the sources you actually consulted in sourcesConsulted.",
  ].join("\n\n");
}

function designPrompt(research: RawRow | undefined, specReview: RawRow | undefined): string {
  return [
    "Freeze the component-API design for the agentic UI library program. Ten parallel implementation lanes build against this spec, so exactness beats prose.",
    `Upstream research notes:\n${String(research?.upstreamNotes ?? "(missing — do your own upstream inspection first)")}`,
    "The lanes and their scopes:",
    ...LANES.map((lane) => `## ${lane.id} (${lane.components.length} components)\n${lane.spec}`),
    HOUSE_RULES,
    "Return specMarkdown covering EVERY planned component: exact file path, exported names (resolving every naming collision with existing exports — preserve backward compatibility where practical), full TypeScript props signature, data-slot names, sui-* class names, the lane-owned CSS fragment file + self-injection mechanism, interaction/keyboard/reduced-motion/screen-reader behavior, streaming/partial-state model, and the provenance registry URL for its fragment entry.",
    "Return componentApis: a compact TypeScript declaration block (exported types/signatures only) lanes can paste against.",
    "Return integrationContract: the EXACT conventions that make the integration lane's job mechanical — per-lane source directory, CSS fragment naming + how each component self-injects the deduplicated stylesheet, provenance fragment file per lane (packages/ui/provenance/<laneId>.json), the append points the integration lane will use for packages/ui/src/index.ts + uiCss.ts + shadcn-provenance.json + gateway-ui barrels, and which components the multi adoption lanes consume.",
    "Design constraint reminders: MessageScroller/ChatTranscript/ChatComposer/Attachment/Reasoning/ChainOfThought/ToolCall/Plan/TaskItem/Sources/InlineCitation/CodeBlock/MessageResponse/AgentOutput ALREADY EXIST — design compound extensions over them, not replacements. No pricing DB in base. Canvas anatomy renderer-neutral (no @xyflow/react in base). Voice surfaces stay deferred.",
    specReview && specReview.approved === false
      ? `Previous spec review feedback (address ALL of it):\n${String(specReview.feedback ?? "")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function specReviewPrompt(spec: RawRow | undefined): string {
  return [
    "Adversarially review this frozen component-API spec before implementation begins. Try to refute it: naming collisions with existing packages/ui and gateway-ui exports, props that cannot express streaming/partial states, CSS or anatomy violating the tokens-only/data-slot/sui-* contract, merge hazards between the ten lanes (shared files, ambiguous append points), divergence from the upstream shadcn/AI-Elements anatomy it claims to port, missing keyboard/reduced-motion/screen-reader behavior, private chain-of-thought leakage, heavy dependencies leaking into the base barrel.",
    "Approve only if an implementer could build every component from the spec alone without inventing API surface.",
    `Spec:\n${String(spec?.specMarkdown ?? "(missing)")}`,
    `APIs:\n${String(spec?.componentApis ?? "(missing)")}`,
    `Integration contract:\n${String(spec?.integrationContract ?? "(missing)")}`,
  ].join("\n\n");
}

function implementPrompt(lane: Lane, spec: RawRow | undefined, feedback: string): string {
  return [
    `Implement lane ${lane.id}: ${lane.title}`,
    `Return laneId=${lane.id} exactly. Planned components for this lane:\n${lane.components.join(", ")}`,
    lane.spec,
    `Frozen API spec (build EXACTLY this surface):\n${String(spec?.componentApis ?? "")}`,
    `Integration contract (your lane-owned files/conventions):\n${String(spec?.integrationContract ?? "")}`,
    `Spec detail (search for your lane's components):\n${String(spec?.specMarkdown ?? "")}`,
    HOUSE_RULES,
    "Definition of done: every planned component implemented (or honestly listed in componentsDeferred with a reason a reviewer can endorse), new behavior covered by tests that went red before your change and green after, `pnpm -C packages/ui test` green in THIS worktree (plus `pnpm -C packages/gateway-ui test` if your lane touched it), and your lane BRANCH carrying the work (commit with jj, explicit pathspecs).",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return componentsImplemented with the EXACT exported names you completed. Return implemented only when focused checks pass here; otherwise return partial or blocked truthfully with the failing output in summary.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validatePrompt(lane: Lane, branch: string, implementation: RawRow | undefined): string {
  return [
    `Validate lane ${lane.id} in this worktree. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    "Steps (run them, do not trust the report):",
    `1. Diff the BRANCH, not the working copy: \`jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat\`. diffNonEmpty=false if the branch carries no changes (an implementer that committed correctly shows work HERE even when \`jj diff\` alone is empty).`,
    "2. Run `pnpm -C packages/ui test` (plus `pnpm -C packages/gateway-ui test` if the diff touches it).",
    "3. Spot-check the new tests actually assert the NEW behavior (open them; a test file that never imports the new component is a false pass). Verify a data-theme=dark render exists for new visual components.",
    "4. Verify the lane did NOT edit shared integration files (packages/ui/src/index.ts, uiCss.ts, shadcn-provenance.json, gateway-ui/src/index.ts, any package.json, lockfiles, docs/**). If it did, allPassed=false.",
    "5. Distinguish INHERITED breakage: if a failure reproduces on files entirely outside the branch diff, note it in summary as inherited and do not count it against the lane.",
    "Set allPassed=false if the report says partial/blocked, any lane-owned check fails, or a claimed test does not exist.",
  ].join("\n");
}

function reviewPrompt(
  lane: Lane,
  seat: Seat,
  spec: RawRow | undefined,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Independent ${seat}-seat review of the green candidate for lane ${lane.id}. Do NOT edit files. Return laneId=${lane.id}, seat=${seat}, and reviewer=<the model identity you actually are> exactly.`,
    `The frozen API surface it must match:\n${String(spec?.componentApis ?? "")}`,
    `Lane scope:\n${lane.spec}`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation report:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Review the DIFF on this lane's branch against: API composition and naming (spec conformance, collision handling, backward compatibility), accessibility (keyboard, screen-reader names, live regions, reduced motion), streaming and partial-state behavior, controlled/uncontrolled correctness, theme-token compliance (no hardcoded colors, dark works), security (URL handling, markdown, iframe sandboxing, secret redaction), bundle boundaries (base barrel stays lightweight, heavy deps behind adapters), provenance fragment accuracy, Gateway-bundling compatibility (CSS as TS strings, self-injection), test quality (red-to-green, real behavior, no hidden fakes/mocks), and no private chain-of-thought exposure.",
    "Judge componentsDeferred honestly: set deferralsEndorsed=true only if every deferral reason is genuinely justified (unnecessary for the program or blocked on an upstream decision), else reject with feedback.",
    "Approve only a complete, minimal, spec-conformant candidate.",
  ].join("\n\n");
}

function mergePrompt(result: RawRow, baseBranch: string, repoRoot: string): string {
  return [
    `Land lane ${String(result.laneId)} onto local ${baseBranch} in the primary checkout at ${repoRoot}. Source worktree: ${String(result.worktreePath)}; source branch/bookmark: ${String(result.branch)}.`,
    `Return laneId=${String(result.laneId)} exactly.`,
    "The primary checkout is jj-colocated, SHARED with concurrent agents, and carries unrelated uncommitted work — preserve it. Use jj, never plain git tree mutations; NEVER git add -A / git commit -a / git stash / git rebase / --amend; never blanket-stage.",
    "Recipe:",
    `1. Verify the lane branch is non-empty: \`jj diff --from "fork_point(${baseBranch} | ${String(result.branch)})" --to ${String(result.branch)} --stat\`. If EMPTY, return mergedToMain=false and explain; never report success for an empty lane.`,
    `2. \`jj rebase -b ${String(result.branch)} -d ${baseBranch}\`; resolve conflicts ONLY inside this lane's files (lane directories, its provenance fragment, its tests).`,
    "3. Run `pnpm -C packages/ui test` (and gateway-ui tests if touched) in the rebased tree.",
    `4. Move ${baseBranch} with compare-and-swap semantics: record the expected old sha first (\`git rev-parse ${baseBranch}\`), then \`git update-ref refs/heads/${baseBranch} <rebased-tip-sha> <expected-old-sha>\`. If the CAS fails, a concurrent lane moved ${baseBranch}: re-read it, re-rebase, retry. Never force-move blindly. Then \`jj git import\`.`,
    `5. Verify with \`git show --name-only <new-tip>\` and \`jj diff --from <expected-old-sha> --to ${baseBranch} --stat\` that ONLY this lane's files landed (a colocated checkout can sweep stale index entries). Verify every PRIOR landed lane is still an ancestor: \`git merge-base --is-ancestor <prior-sha> ${baseBranch}\`. If one was orphaned, recover it (linear-chain cherry-pick in a scratch worktree, CAS update-ref, jj git import) before returning.`,
    "6. Do NOT push to origin. Local landing only.",
  ].join("\n");
}

function integrationPrompt(
  spec: RawRow | undefined,
  merges: RawRow[],
  laneResults: RawRow[],
  feedback: string,
): string {
  return [
    "Integration lane: you own every shared surface the component lanes were forbidden to touch. Work in the PRIMARY checkout (jj-colocated, shared, with unrelated uncommitted work to preserve — jj st / jj diff are truth; commit ONLY your files with explicit pathspecs; never blanket-stage/stash/rebase/amend).",
    "Return laneId=integration exactly.",
    `Integration contract from the frozen spec:\n${String(spec?.integrationContract ?? "")}`,
    `Lane results (componentsImplemented/deferred per lane):\n${JSON.stringify(laneResults, null, 2)}`,
    `Merge results (if any lane reports mergedToMain=false, land it yourself FIRST from its worktree/branch using the same CAS recipe the merge tasks used):\n${JSON.stringify(merges, null, 2)}`,
    [
      "Checklist (all of it):",
      "1. Resolve naming collisions with existing exports; preserve backward compatibility where practical.",
      "2. Add every new public export to packages/ui/src/index.ts (base barrel stays lightweight — heavy renderers stay behind adapters/* subpaths) and to packages/gateway-ui/src/index.ts for the new gateway bindings.",
      "3. Compose all lane CSS fragments into packages/ui/src/uiCss.ts per the contract's append points; every component self-injects the deduplicated stylesheet.",
      "4. Update packages/ui/shadcn-provenance.json from the lane provenance fragments in packages/ui/provenance/ (keep fragments as the source of truth).",
      "5. Update package exports for any new heavy adapter subpaths (packages/ui/package.json exports + the packages/smithers facade files under packages/smithers/src/ui/, following the existing adapter facade pattern) and add the required scripts/ui-architecture-baseline.json inventory entries for new adapters.",
      "6. If dependencies changed anywhere, refresh BOTH pnpm-lock.yaml and bun.lock in the same commit.",
      "7. Update packages/ui README + component docs (docs/reference/ui.mdx and friends) for the new surface; run node scripts/check-docs.mjs and fix what it flags. Regenerate llms bundles (pnpm docs:llms) ONLY if `jj st` shows no foreign uncommitted docs changes; otherwise report the conflict in summary instead of baking foreign WIP into bundles.",
      "8. Add a complete component gallery/styleguide route covering the new families (follow the existing styleguide surface conventions) so every component is visually discoverable.",
      "9. Add focused REAL-browser coverage (headless Chromium via the repo's existing playwright harness patterns) for: streaming conversation scroll behavior, keyboard transcript navigation, prompt submission and stop, attachments, tool disclosure, approval approve/deny/note, checkpoint fork/replay/rewind confirmation, structured node output, test failure + stack trace rendering, theme switching, reduced motion, and screen-reader names/live-region behavior. If a scenario is impossible in the current harness, record it explicitly in summary as deferred with the reason.",
      "10. Confirm tree-shaking / base-barrel dependency constraints (node scripts/check-ui-architecture.mjs) and run: pnpm typecheck, pnpm -C packages/ui test, pnpm -C packages/gateway-ui test.",
    ].join("\n"),
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return implemented only when the checks you ran are green; otherwise partial/blocked truthfully with failing output in summary.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function integrationReviewPrompt(seat: Seat, implementation: RawRow | undefined, ci: RawRow | undefined): string {
  return [
    `Independent ${seat}-seat review of the INTEGRATION lane (critical shared surface — both seats must approve). Do NOT edit files. Return laneId=integration, seat=${seat}, reviewer=<your model identity>.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `CI gate:\n${JSON.stringify(ci ?? null, null, 2)}`,
    "Verify ON DISK in the primary checkout: barrels export the full frozen surface (and nothing heavy leaked into the base barrel), uiCss.ts composition is deduplicated and complete, shadcn-provenance.json matches the fragments, adapter subpath exports + facade files + baseline entries exist, lockfiles are consistent with manifest changes, docs match the public surface, the gallery route covers the new families, browser coverage exists for the listed interactions (or is honestly deferred in the report), and no unrelated working-copy changes were swept into the integration commits (check `git show --name-only` on them).",
    "Approve only if the integration is complete and the CI gate is genuinely green.",
  ].join("\n\n");
}

function adoptionImplementPrompt(lane: Lane, spec: RawRow | undefined, feedback: string): string {
  return [
    `Implement Multi adoption lane ${lane.id}: ${lane.title}`,
    `Return laneId=${lane.id} exactly. Shared components to consume:\n${lane.components.join(", ")}`,
    lane.spec,
    MULTI_RULES,
    `Frozen API surface of the shared library:\n${String(spec?.componentApis ?? "")}`,
    "Definition of done: the refactored surfaces render through the shared components with behavior preserved (existing tests stay green; add focused tests for the new rendering paths), pnpm check:ui-architecture and pnpm typecheck green, your work committed via jj with explicit pathspecs, unrelated working-copy changes untouched.",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return componentsImplemented with the shared components actually adopted. Return implemented only when the focused checks pass; otherwise partial/blocked truthfully.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function adoptionValidatePrompt(lane: Lane, implementation: RawRow | undefined): string {
  return [
    `Validate Multi adoption lane ${lane.id} in ${MULTI_ROOT}. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    "Steps (run them in the Multi repo, do not trust the report):",
    "1. `jj log -r 'mine() & description(glob:\"*\")' -n 10` + `jj st`: confirm the lane's commits exist, contain ONLY lane-relevant files, and the unrelated dirty working copy was not swept in (diffNonEmpty=false if no lane commits exist).",
    "2. Run pnpm check:ui-architecture, pnpm test:ui-architecture, pnpm typecheck, and the focused tests for the touched surfaces.",
    "3. Verify no duplicate local wrappers were created, no AI Elements dependency and no @smthrs/gateway-ui dependency were added (check package.json), and raw/source fallbacks remain where structured renderers took over.",
    "4. Spot-check preserved behaviors named in the lane spec (stores, imperative handles, persistence, streaming, dictation as applicable).",
    "5. Distinguish INHERITED breakage (failures on files outside the lane's commits) and note it in summary without failing the lane for it.",
    "Set allPassed=false if the report is partial/blocked, a lane-owned check fails, or a claimed test does not exist.",
  ].join("\n");
}

function auditPrompt(seat: Seat, ctx: any): string {
  const laneResults = rawRows(ctx, "aguiLaneResult");
  const merges = rawRows(ctx, "aguiMerge");
  const ciRows = rawRows(ctx, "aguiCi");
  const plannedByLane = ALL_LANES.map((lane) => `${lane.id}: ${lane.components.join(", ")}`).join("\n");
  return [
    `Final ${seat}-seat audit of the agentic UI library program (both seats must independently return complete=true for the program to succeed). Verify ON DISK — read the actual files on local main in the smithers repo and in ${MULTI_ROOT} — never trust the reports alone.`,
    `Return seat=${seat} exactly.`,
    `Planned components per lane:\n${plannedByLane}`,
    `Explicitly deferred program-wide (endorse or reject each; deferralsEndorsed=true means you endorse ALL standing deferrals, including per-lane componentsDeferred):\n${EXPLICIT_DEFERRALS.join(", ")}`,
    "Build coverageMatrix with ONE row per planned component per lane above: state=integrated when it is exported from the shared barrels on main (or shipped adapter subpaths) with provenance + docs; adopted when a Multi surface consumes it; reviewed when reviewed but not yet integrated; implemented when on a lane branch but unmerged; deferred when endorsed-deferred; planned otherwise. Use note for anything surprising.",
    "complete=true ONLY if: every listed component is integrated or endorsed-deferred, all required reviews passed, shared exports/CSS/provenance/docs are synchronized, the smithers CI row is genuinely green and current, the multi CI row is genuinely green and current, and no unrelated working-copy changes were overwritten in either repo (spot-check `jj st` in both).",
    "In followUps name any deferred adoption work SEPARATELY from component completion.",
    `Lane results:\n${JSON.stringify(laneResults, null, 2)}`,
    `Merges:\n${JSON.stringify(merges, null, 2)}`,
    `CI rows:\n${JSON.stringify(
      ciRows.map((row) => ({ nodeId: row.nodeId, scope: row.scope, allPassed: row.allPassed, summary: row.summary })),
      null,
      2,
    )}`,
  ].join("\n\n");
}

function ciFixPrompt(scope: "smithers" | "multi", ci: RawRow | undefined): string {
  const where = scope === "smithers" ? "the smithers primary checkout" : `the Multi repo at ${MULTI_ROOT}`;
  return [
    `The ${scope} CI gate is red in ${where}. Fix it minimally so all gates pass. Return scope=${scope} exactly.`,
    `Gate output:\n${JSON.stringify(ci ?? null, null, 2)}`,
    "You are in a SHARED checkout with unrelated uncommitted work. Touch only files implicated by the failures; commit with explicit pathspecs via jj; NEVER blanket-stage/stash/amend/rebase. If a failure is INHERITED (reproduces on files entirely outside this program's changes), say so in summary and leave it alone rather than chasing foreign breakage.",
    scope === "smithers"
      ? "check-llms failures mean regenerating bundles: run `pnpm docs:llms` ONLY if `jj st` shows no foreign uncommitted docs changes; otherwise report the conflict."
      : "",
    "Re-run the exact failed commands until green.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── Workflow ────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 3,
    perLaneIterations: ctx.input.perLaneIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "agui"));

  const research = latestRaw(rawRows(ctx, "aguiResearch"), "agui-research");
  const spec = latestRaw(rawRows(ctx, "aguiSpec"), "design-freeze");
  const specReview = latestRaw(rawRows(ctx, "aguiSpecReview"), "design-review");
  const specApproved = sameVersion(spec, specReview) && specReview?.approved === true;
  const specSettled = specApproved || rawRows(ctx, "aguiSpec").length >= 2;

  const laneResults = rawRows(ctx, "aguiLaneResult");
  const merges = rawRows(ctx, "aguiMerge");
  const lanesSettled = LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const lgtmResults = laneResults.filter((row) => LANES.some((lane) => lane.id === row.laneId) && row.lgtm === true);
  const mergesSettled = lanesSettled && lgtmResults.every((row) => merges.some((merge) => merge.laneId === row.laneId));

  const integrationLane: Lane = {
    id: "integration",
    title: "Shared-surface integration (barrels, CSS, provenance, manifests, locks, docs, gallery)",
    seats: ["fable", "sol"],
    components: [],
    spec: "",
  };
  const integrationImplRows = rawRows(ctx, "aguiImpl").filter(
    (row) => baseNodeId(row) === "integration-implement" && row.laneId === "integration",
  );
  const integrationImpl = latestRaw(integrationImplRows, "integration-implement");
  const smithersCi = latestRaw(
    rawRows(ctx, "aguiCi").filter((row) => row.scope === "smithers"),
    "integration-ci",
  );
  const smithersCiCurrent = sameVersion(integrationImpl, smithersCi);
  const integrationReviews = (["fable", "sol"] as Seat[]).map((seat) => {
    const review = latestRaw(
      rawRows(ctx, "aguiReview").filter((row) => row.laneId === "integration" && row.seat === seat),
      `integration-review-${seat}`,
    );
    return { seat, review, current: smithersCiCurrent && sameVersion(smithersCi, review) };
  });
  const integrationReviewsCurrent = integrationReviews.every((entry) => entry.current);
  const integrationDone =
    integrationImpl?.status === "implemented" &&
    smithersCiCurrent &&
    smithersCi?.allPassed === true &&
    integrationReviewsCurrent &&
    integrationReviews.every((entry) => entry.review?.approved === true);
  const integrationSettled =
    integrationDone ||
    (integrationImplRows.length >= 3 &&
      smithersCiCurrent &&
      (smithersCi?.allPassed === false || integrationReviewsCurrent));
  const integrationFeedback = [
    smithersCiCurrent && smithersCi?.allPassed === false
      ? `SMITHERS CI GATE FAILED:\n${String(smithersCi.summary ?? "")}`
      : "",
    ...integrationReviews.map((entry) =>
      entry.current && entry.review?.approved === false
        ? `REVIEW (${entry.seat} seat) NOT LGTM:\n${String(entry.review.feedback ?? "")}`
        : "",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const adoptionStates = ADOPTION_LANES.map((lane) => ({
    lane,
    state: laneState(ctx, lane, input.perLaneIterations, `adopt-${lane.id.replace(/^adopt-/, "")}`),
  }));
  const adoptionSettled = ADOPTION_LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const multiCi = latestRaw(
    rawRows(ctx, "aguiCi").filter((row) => row.scope === "multi"),
    "multi-ci",
  );
  const multiCiGreen = multiCi?.allPassed === true;
  const multiCiSettled = multiCiGreen || rawRows(ctx, "aguiCi").filter((row) => row.scope === "multi").length >= 3;

  const audits = rawRows(ctx, "aguiAudit");
  const auditFable = latestRaw(
    audits.filter((row) => row.seat === "fable"),
    "final-audit-fable",
  );
  const auditSol = latestRaw(
    audits.filter((row) => row.seat === "sol"),
    "final-audit-sol",
  );
  const auditsComplete =
    auditFable?.complete === true &&
    auditSol?.complete === true &&
    auditFable?.deferralsEndorsed === true &&
    auditSol?.deferralsEndorsed === true;

  const readyForAudit =
    specSettled &&
    lanesSettled &&
    mergesSettled &&
    integrationSettled &&
    (integrationDone ? adoptionSettled && multiCiSettled : true);

  const manifestLanes: z.infer<typeof manifestSchema>["lanes"] = [
    ...ALL_LANES.map((lane) => ({
      laneId: lane.id,
      title: lane.title,
      kind: (lane.id.startsWith("adopt-") ? "adoption" : "component") as "adoption" | "component" | "integration",
      implementModel: "opencode/kimi-for-coding-k3 (fallback claude-sonnet-5)",
      reviewSeats: lane.seats as string[],
      components: lane.components,
    })),
    {
      laneId: "integration",
      title: integrationLane.title,
      kind: "integration",
      implementModel: "opencode/kimi-for-coding-k3 (fallback claude-sonnet-5)",
      reviewSeats: ["fable", "sol"],
      components: [],
    },
  ];

  return (
    <Workflow name="build-agentic-ui-library">
      <UI entry="../ui/build-agentic-ui-library.tsx" title="Agentic UI Library Program" />
      <Sequence>
        <Task id="agui-manifest" output={outputs.aguiManifest}>
          {{
            programTitle: "Agentic UI component program",
            plannedComponents: plannedComponentTotal,
            lanes: manifestLanes,
          }}
        </Task>

        <Task
          id="agui-research"
          output={outputs.aguiResearch}
          agent={fableChain}
          retries={2}
          timeoutMs={45 * 60_000}
          heartbeatTimeoutMs={10 * 60_000}
        >
          {researchPrompt()}
        </Task>

        <Loop id="agui-design-loop" until={specApproved} maxIterations={2} onMaxReached="return-last">
          <Sequence>
            <Task
              id="design-freeze"
              output={outputs.aguiSpec}
              agent={fableChain}
              retries={2}
              timeoutMs={90 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {designPrompt(research, specReview)}
            </Task>
            <Task
              id="design-review"
              output={outputs.aguiSpecReview}
              agent={solChain}
              retries={2}
              timeoutMs={40 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {specReviewPrompt(spec)}
            </Task>
          </Sequence>
        </Loop>

        {specSettled ? (
          <Parallel maxConcurrency={input.maxConcurrency}>
            {LANES.map((lane) => {
              const branch = `agui/${runSlug}/${lane.id}`;
              const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", "agui", runSlug, lane.id);
              const state = laneState(ctx, lane, input.perLaneIterations);
              return (
                <Worktree key={lane.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                  <Sequence>
                    <Loop
                      id={`lane-${lane.id}-loop`}
                      until={state.done}
                      maxIterations={input.perLaneIterations}
                      onMaxReached="return-last"
                    >
                      <Sequence>
                        <Task
                          id={`lane-${lane.id}-implement`}
                          output={outputs.aguiImpl}
                          agent={kimiImplement}
                          retries={2}
                          timeoutMs={100 * 60_000}
                          heartbeatTimeoutMs={15 * 60_000}
                        >
                          {implementPrompt(lane, spec, laneFeedback(state))}
                        </Task>
                        <Task
                          id={`lane-${lane.id}-validate`}
                          output={outputs.aguiValidation}
                          agent={validateChain}
                          retries={2}
                          timeoutMs={40 * 60_000}
                          heartbeatTimeoutMs={10 * 60_000}
                        >
                          {validatePrompt(lane, branch, state.implementation)}
                        </Task>
                        {state.validationCurrent &&
                        state.validation?.allPassed === true &&
                        state.validation?.diffNonEmpty === true ? (
                          <Parallel>
                            {lane.seats.map((seat) => (
                              <Task
                                key={seat}
                                id={`lane-${lane.id}-review-${seat}`}
                                output={outputs.aguiReview}
                                agent={seat === "fable" ? fableChain : solChain}
                                retries={2}
                                timeoutMs={40 * 60_000}
                                heartbeatTimeoutMs={10 * 60_000}
                              >
                                {reviewPrompt(lane, seat, spec, state.implementation, state.validation)}
                              </Task>
                            ))}
                          </Parallel>
                        ) : null}
                      </Sequence>
                    </Loop>
                    <Task id={`lane-${lane.id}-result`} output={outputs.aguiLaneResult}>
                      {{
                        laneId: lane.id,
                        branch,
                        worktreePath,
                        lgtm: state.done,
                        exhausted: state.exhausted,
                        attempts: state.attempts,
                        summary: state.done
                          ? `Lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                          : `Lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                        filesChanged: asArray(state.implementation?.filesChanged) as string[],
                        componentsImplemented: asArray(state.implementation?.componentsImplemented) as string[],
                        componentsDeferred: asArray(state.implementation?.componentsDeferred) as {
                          name: string;
                          reason: string;
                        }[],
                        seatVerdicts: state.reviews.map((entry) => ({
                          seat: entry.seat,
                          approved: entry.current && entry.review?.approved === true,
                          reviewer: String(entry.review?.reviewer ?? "(none)"),
                        })),
                      }}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        <MergeQueue id="agui-merge-queue" maxConcurrency={1}>
          {(lanesSettled
            ? lgtmResults.filter(
                (row) => !merges.some((merge) => merge.laneId === row.laneId && merge.mergedToMain === true),
              )
            : []
          ).map((row) => (
            <Task
              key={String(row.laneId)}
              id={`merge-${slug(String(row.laneId))}`}
              output={outputs.aguiMerge}
              agent={mergeChain}
              retries={2}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {mergePrompt(row, input.baseBranch, repoRoot)}
            </Task>
          ))}
        </MergeQueue>

        {lanesSettled && mergesSettled ? (
          <Loop id="integration-loop" until={integrationDone} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task
                id="integration-implement"
                output={outputs.aguiImpl}
                agent={kimiImplement}
                retries={2}
                timeoutMs={120 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {integrationPrompt(spec, merges, laneResults, integrationFeedback)}
              </Task>
              <Task id="integration-ci" output={outputs.aguiCi} timeoutMs={150 * 60_000}>
                {() => runSmithersCi(repoRoot)}
              </Task>
              {smithersCiCurrent && smithersCi?.allPassed === true ? (
                <Parallel>
                  {(["fable", "sol"] as Seat[]).map((seat) => (
                    <Task
                      key={seat}
                      id={`integration-review-${seat}`}
                      output={outputs.aguiReview}
                      agent={seat === "fable" ? fableChain : solChain}
                      retries={2}
                      timeoutMs={45 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                    >
                      {integrationReviewPrompt(seat, integrationImpl, smithersCi)}
                    </Task>
                  ))}
                </Parallel>
              ) : null}
            </Sequence>
          </Loop>
        ) : null}

        {integrationDone ? (
          <Sequence>
            {ADOPTION_LANES.map((lane) => {
              const prefix = `adopt-${lane.id.replace(/^adopt-/, "")}`;
              const state = adoptionStates.find((entry) => entry.lane.id === lane.id)!.state;
              return (
                <Sequence key={lane.id}>
                  <Loop
                    id={`${prefix}-loop`}
                    until={state.done}
                    maxIterations={input.perLaneIterations}
                    onMaxReached="return-last"
                  >
                    <Sequence>
                      <Task
                        id={`${prefix}-implement`}
                        output={outputs.aguiImpl}
                        agent={kimiImplementMulti}
                        retries={2}
                        timeoutMs={100 * 60_000}
                        heartbeatTimeoutMs={15 * 60_000}
                      >
                        {adoptionImplementPrompt(lane, spec, laneFeedback(state))}
                      </Task>
                      <Task
                        id={`${prefix}-validate`}
                        output={outputs.aguiValidation}
                        agent={validateChainMulti}
                        retries={2}
                        timeoutMs={45 * 60_000}
                        heartbeatTimeoutMs={10 * 60_000}
                      >
                        {adoptionValidatePrompt(lane, state.implementation)}
                      </Task>
                      {state.validationCurrent &&
                      state.validation?.allPassed === true &&
                      state.validation?.diffNonEmpty === true ? (
                        <Parallel>
                          {lane.seats.map((seat) => (
                            <Task
                              key={seat}
                              id={`${prefix}-review-${seat}`}
                              output={outputs.aguiReview}
                              agent={seat === "fable" ? fableChainMulti : solChainMulti}
                              retries={2}
                              timeoutMs={40 * 60_000}
                              heartbeatTimeoutMs={10 * 60_000}
                            >
                              {reviewPrompt(lane, seat, spec, state.implementation, state.validation)}
                            </Task>
                          ))}
                        </Parallel>
                      ) : null}
                    </Sequence>
                  </Loop>
                  <Task id={`${prefix}-result`} output={outputs.aguiLaneResult}>
                    {{
                      laneId: lane.id,
                      branch: "(multi working copy)",
                      worktreePath: MULTI_ROOT,
                      lgtm: state.done,
                      exhausted: state.exhausted,
                      attempts: state.attempts,
                      summary: state.done
                        ? `Adoption lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                        : `Adoption lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                      filesChanged: asArray(state.implementation?.filesChanged) as string[],
                      componentsImplemented: asArray(state.implementation?.componentsImplemented) as string[],
                      componentsDeferred: asArray(state.implementation?.componentsDeferred) as {
                        name: string;
                        reason: string;
                      }[],
                      seatVerdicts: state.reviews.map((entry) => ({
                        seat: entry.seat,
                        approved: entry.current && entry.review?.approved === true,
                        reviewer: String(entry.review?.reviewer ?? "(none)"),
                      })),
                    }}
                  </Task>
                </Sequence>
              );
            })}

            {adoptionSettled ? (
              <Loop id="multi-ci-loop" until={multiCiGreen} maxIterations={3} onMaxReached="return-last">
                <Sequence>
                  <Task id="multi-ci" output={outputs.aguiCi} timeoutMs={130 * 60_000}>
                    {() => runMultiCi(MULTI_ROOT)}
                  </Task>
                  {multiCi && multiCi.allPassed === false ? (
                    <Task
                      id="multi-ci-fix"
                      output={outputs.aguiCiFix}
                      agent={kimiImplementMulti}
                      retries={2}
                      timeoutMs={60 * 60_000}
                      heartbeatTimeoutMs={15 * 60_000}
                    >
                      {ciFixPrompt("multi", multiCi)}
                    </Task>
                  ) : null}
                </Sequence>
              </Loop>
            ) : null}
          </Sequence>
        ) : null}

        {readyForAudit ? (
          <Parallel>
            <Task
              id="final-audit-fable"
              output={outputs.aguiAudit}
              agent={fableChain}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {auditPrompt("fable", ctx)}
            </Task>
            <Task
              id="final-audit-sol"
              output={outputs.aguiAudit}
              agent={solChain}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {auditPrompt("sol", ctx)}
            </Task>
          </Parallel>
        ) : null}

        {readyForAudit && auditFable !== undefined && auditSol !== undefined ? (
          <Task id="agui-final-report" output={outputs.aguiFinal}>
            {{
              success: auditsComplete && integrationDone && multiCiGreen,
              lanesLgtm: lgtmResults.length,
              lanesTotal: LANES.length,
              integrationDone,
              adoptionDone:
                adoptionSettled &&
                ADOPTION_LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id && row.lgtm === true)),
              smithersCiGreen: smithersCi?.allPassed === true,
              multiCiGreen,
              auditsComplete,
              summary:
                auditsComplete && integrationDone && multiCiGreen
                  ? `Program complete: ${lgtmResults.length}/${LANES.length} component lanes LGTM, integration + adoption landed, both audits complete.`
                  : `Program settled incomplete: ${lgtmResults.length}/${LANES.length} lanes LGTM; integrationDone=${integrationDone}; multiCiGreen=${multiCiGreen}; audits fable=${auditFable?.complete === true} sol=${auditSol?.complete === true}. See audit followUps.`,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
