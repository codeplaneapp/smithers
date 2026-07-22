/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityGroup,
  ActivityItem,
  ActivityTimeline,
  AgentCard,
  AgentContent,
  AgentDefinition,
  AgentHeader,
  AgentInstructions,
  AgentOutput,
  AgentOutputSchema,
  AgentSandbox,
  AgentSandboxActions,
  AgentSandboxContent,
  AgentSandboxHeader,
  AgentSandboxStatus,
  AgentTask,
  AgentTaskContent,
  AgentTaskGroup,
  AgentTaskTrigger,
  AgentTool,
  AgentTools,
  ApprovalCard,
  Artifact,
  ArtifactActions,
  ArtifactClose,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentRemove,
  AttachmentTitle,
  Bubble,
  BubbleActions,
  BubbleContent,
  BubbleReactions,
  ChainOfThought,
  ChainOfThoughtStep,
  ChangeSummary,
  ChatTranscript,
  Checkpoint,
  CheckpointActions,
  CheckpointIcon,
  CheckpointMetadata,
  CheckpointTrigger,
  CitationCard,
  CitationCarousel,
  CitationQuote,
  CodeBlock,
  CodeBlockGroup,
  Commit,
  CommitAuthor,
  CommitFile,
  CommitFiles,
  CommitHash,
  CommitHeader,
  CommitMessage,
  CommitMetadata,
  CommitTimestamp,
  CompactGroup,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
  ContextUsage,
  ConversationCheckpoint,
  EnvironmentVariable,
  EnvironmentVariables,
  InlineCitation,
  JSXPreview,
  Marker,
  Message,
  MessageAvatar,
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageContent,
  MessageHeader,
  MessageGroup,
  MessageResponse,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  ModelBadge,
  ModelSelector,
  OpenInChat,
  PackageInfo,
  Plan,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanStep,
  PlanTitle,
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputStop,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  ProviderBadge,
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
  Reasoning,
  ReasoningContent,
  ReasoningSummary,
  ReasoningTrigger,
  SchemaDisplay,
  SecretField,
  Shimmer,
  Snippet,
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
  StackTrace,
  Suggestion,
  SuggestionGroup,
  TaskItem,
  TaskItemFile,
  TestResults,
  ToolCall,
  ToolCallContent,
  ToolCallHeader,
  ToolCallInput,
  ToolCallOutput,
  WebPreview,
  WebPreviewAddress,
  WebPreviewContent,
  WebPreviewToolbar,
  WorkflowCanvas,
  WorkflowConnection,
  WorkflowControls,
  WorkflowEdge,
  WorkflowMinimap,
  WorkflowNode,
  WorkflowNodeContent,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
  WorkflowPanel,
  WorkflowToolbar,
  type AgentOutputModel,
  type ApprovalState,
  type CheckpointActionKind,
  type ModelOption,
  type PromptInputMessage,
  SmithersUiStyles,
} from "@smithers-orchestrator/ui";

type GalleryMessage = { id: string; role: "user" | "assistant"; text: string };

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-testid={`gallery-section-${id}`} style={{ display: "grid", gap: 12, marginBottom: 40 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}

/** Streaming transcript with follow/pin behavior driven from local state. */
function TranscriptDemo({ messages }: { messages: readonly GalleryMessage[] }) {
  return (
    <MessageScrollerProvider scrollAnchor="bottom" streaming>
      <div style={{ position: "relative", height: 220, border: "1px solid #8884", borderRadius: 8 }}>
        <MessageScrollerViewport data-testid="transcript-viewport" style={{ height: "100%" }}>
          <MessageScrollerContent data-testid="transcript-log">
            {messages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                <Message role={message.role}>
                  <MessageHeader>
                    <MessageAvatar fallback={message.role === "user" ? "U" : "A"} />
                  </MessageHeader>
                  <MessageContent>{message.text}</MessageContent>
                </Message>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </div>
    </MessageScrollerProvider>
  );
}

function BranchDemo() {
  const [branch, setBranch] = useState(0);
  const branches = ["First draft of the answer.", "Second draft of the answer.", "Third draft of the answer."];
  return (
    <MessageBranch data-testid="message-branch" count={branches.length} index={branch} onIndexChange={setBranch}>
      <MessageBranchContent>
        {branches.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </MessageBranchContent>
      <MessageBranchSelector>
        <MessageBranchPrevious aria-label="Previous branch" />
        <MessageBranchPage />
        <MessageBranchNext aria-label="Next branch" />
      </MessageBranchSelector>
    </MessageBranch>
  );
}

function ComposerDemo({ onSubmit }: { onSubmit: (message: PromptInputMessage) => void }) {
  const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <PromptInput
      data-testid="prompt-input"
      status={status}
      onSubmit={(message) => {
        onSubmit(message);
        setStatus("streaming");
        timer.current = setTimeout(() => setStatus("ready"), 10_000);
      }}
      onStop={() => {
        if (timer.current) clearTimeout(timer.current);
        setStatus("ready");
      }}
    >
      <PromptInputHeader />
      <PromptInputBody>
        <PromptInputTextarea aria-label="Message" placeholder="Ask anything" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger aria-label="Open actions" />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments>Add attachment</PromptInputActionAddAttachments>
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        </PromptInputTools>
        {status === "streaming" ? <PromptInputStop aria-label="Stop generating" /> : <PromptInputSubmit aria-label="Send message" />}
      </PromptInputFooter>
    </PromptInput>
  );
}

function AttachmentsDemo() {
  const [items, setItems] = useState([
    { id: "a1", name: "trace.log", state: "ready" as const },
    { id: "a2", name: "screenshot.png", state: "uploading" as const },
  ]);
  return (
    <AttachmentGroup data-testid="attachment-group">
      {items.map((item) => (
        <Attachment key={item.id} name={item.name} state={item.state}>
          <AttachmentMedia />
          <AttachmentContent>
            <AttachmentTitle>{item.name}</AttachmentTitle>
            <AttachmentDescription>{item.state}</AttachmentDescription>
          </AttachmentContent>
          <AttachmentRemove aria-label={`Remove ${item.name}`} onClick={() => setItems((all) => all.filter((x) => x.id !== item.id))} />
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}

function ToolDisclosureDemo() {
  return (
    <ToolCall name="read_file" state="output-available" durationMs={812} data-testid="tool-call">
      <ToolCallHeader />
      <ToolCallContent>
        <ToolCallInput args={{ path: "src/index.ts" }} />
        <ToolCallOutput result={{ lines: 226 }} />
      </ToolCallContent>
    </ToolCall>
  );
}

function ApprovalDemo() {
  const [state, setState] = useState<ApprovalState>("requested");
  return (
    <div data-testid="approval-demo" style={{ display: "grid", gap: 12 }}>
      <div data-testid="confirmation-demo">
        <Confirmation state={state}>
          <ConfirmationTitle>Deploy to production</ConfirmationTitle>
          <ConfirmationRequest>Run terraform apply against the production workspace?</ConfirmationRequest>
          <ConfirmationAccepted />
          <ConfirmationRejected />
        </Confirmation>
      </div>
      <ApprovalCard
        title="Deploy to production"
        state={state}
        risk="high"
        proposedActions={["terraform plan", "terraform apply"]}
        resources={[{ id: "r1", kind: "branch", label: "agui/run-1784654981789" }]}
        onNoteChange={() => {}}
        onApprove={() => setState("approved")}
        onDeny={() => setState("denied")}
      />
    </div>
  );
}

function CheckpointDemo() {
  const [log, setLog] = useState<string[]>([]);
  const [pending, setPending] = useState<CheckpointActionKind | null>(null);
  return (
    <div data-testid="checkpoint-demo">
      <Checkpoint checkpoint={{ id: "cp-12", frameNo: 12, timestampMs: 1_700_000_000_000, messageCount: 8 }}>
        <CheckpointIcon />
        <CheckpointMetadata />
        <CheckpointTrigger />
        <CheckpointActions
          actions={["fork", "replay", "rewind"]}
          onAction={(kind) => setPending(kind)}
        />
      </Checkpoint>
      {pending ? (
        <div role="alertdialog" aria-label={`Confirm ${pending}`} data-testid="checkpoint-confirm">
          <p>{pending === "rewind" ? "Rewind deletes later frames. Continue?" : `Run ${pending} from checkpoint cp-12?`}</p>
          <button
            type="button"
            data-testid="checkpoint-confirm-yes"
            onClick={() => {
              setLog((entries) => [...entries, pending]);
              setPending(null);
            }}
          >
            Confirm {pending}
          </button>
          <button type="button" data-testid="checkpoint-confirm-no" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      <ul data-testid="checkpoint-log">
        {log.map((entry, index) => (
          <li key={index}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

const NODE_OUTPUT_MODEL: AgentOutputModel = {
  response: "Implemented the integration barrel.",
  toolCalls: [{ name: "edit", state: "output-available", args: { file: "packages/ui/src/index.ts" } }],
  streaming: false,
};

const FAILING_SUITES = [
  {
    id: "suite-ui",
    name: "packages/ui",
    tests: [
      { id: "t1", name: "renders the barrel", status: "passed" as const, durationMs: 42 },
      {
        id: "t2",
        name: "composes lane css",
        status: "failed" as const,
        durationMs: 87,
        errorText: "Expected reducedMotionCss composed last",
      },
    ],
  },
];

const STACK = `Error: Expected reducedMotionCss composed last
    at assertOrder (packages/ui/tests/css.test.ts:12:9)
    at packages/ui/tests/css.test.ts:44:3
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const CITATION_SOURCE = {
  id: "s1",
  title: "Integration contract",
  url: "https://example.com/contract",
  domain: "example.com",
  excerpt: "Keep both EOF blocks.",
};

const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
];

function CodeBlockTabsDemo() {
  const items = [
    { id: "a", label: "a.ts", code: "export const a = 1;", language: "typescript" },
    { id: "b", label: "b.ts", code: "export const b = 2;", language: "typescript" },
  ];
  const [activeId, setActiveId] = useState("a");
  return <CodeBlockGroup data-testid="code-block-group" items={items} activeId={activeId} onActiveIdChange={setActiveId} />;
}

export function GalleryCanvas() {
  const [messages, setMessages] = useState<GalleryMessage[]>([
    { id: "m1", role: "user", text: "Land the integration lane." },
    { id: "m2", role: "assistant", text: "Merging the barrel now." },
  ]);
  const streamCount = useRef(0);
  const appendStreaming = useCallback(() => {
    streamCount.current += 1;
    const id = `stream-${streamCount.current}`;
    setMessages((all) => [...all, { id, role: "assistant", text: `Streaming chunk ${streamCount.current}` }]);
  }, []);
  const [theme, setTheme] = useState<"" | "light" | "dark">("");

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
    return () => document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  return (
    <div data-testid="ui-gallery" style={{ padding: 24, maxWidth: 860, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <SmithersUiStyles />
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Agentic UI gallery</h1>
        <button
          type="button"
          data-testid="theme-toggle"
          aria-label="Toggle theme"
          onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
        >
          Theme: {theme || "system"}
        </button>
      </header>

      <Section id="transcript" title="Conversation">
        <button type="button" data-testid="stream-chunk" onClick={appendStreaming}>
          Stream chunk
        </button>
        <TranscriptDemo messages={messages} />
        <BranchDemo />
        <MessageGroup>
          <Bubble>
            <BubbleContent>Bubble body</BubbleContent>
            <BubbleActions>
              <button type="button">Copy</button>
            </BubbleActions>
            <BubbleReactions reactions={[{ key: "plus-one", label: "+1", count: 2 }]} />
          </Bubble>
        </MessageGroup>
        <CompactGroup count={12}>Collapsed tool activity</CompactGroup>
        <ConversationCheckpoint label="Checkpoint before rewrite" />
        <Marker>Streaming</Marker>
        <Shimmer style={{ width: 120, height: 12 }} />
        <ChatTranscript
          data-testid="chat-transcript"
          pending
          pendingLabel="Assistant is composing"
          empty="No messages yet"
          style={{ height: 160, border: "1px solid #8884", borderRadius: 8 }}
        >
          <Message role="user">
            <MessageContent>Recap the integration.</MessageContent>
          </Message>
        </ChatTranscript>
      </Section>

      <Section id="composer" title="Prompt and attachments">
        <ComposerDemo
          onSubmit={(message) => {
            if (message.text) {
              setMessages((all) => [...all, { id: `user-${all.length}`, role: "user", text: message.text }]);
            }
          }}
        />
        <AttachmentsDemo />
      </Section>

      <Section id="reasoning-tools" title="Reasoning and tools">
        <Reasoning data-testid="reasoning">
          <ReasoningTrigger />
          <ReasoningContent>
            <ReasoningSummary text="Compared merge strategies and picked CAS." />
          </ReasoningContent>
        </Reasoning>
        <ChainOfThought
          steps={[
            { id: "c1", label: "Rebase lanes", status: "done" },
            { id: "c2", label: "Merge barrel", status: "active" },
            { id: "c3", label: "Browser coverage", status: "pending" },
          ]}
        />
        <ChainOfThought>
          <ChainOfThoughtStep label="Compound step" status="active">
            Step body
          </ChainOfThoughtStep>
        </ChainOfThought>
        <ToolDisclosureDemo />
        <div data-testid="node-output-demo">
          <AgentOutput model={NODE_OUTPUT_MODEL} />
        </div>
        <MessageResponse content="**bold** response text" />
        <CodeBlock data-testid="code-block" code={"const x = 1;\nconst y = 2;"} language="typescript" showLineNumbers />
        <CodeBlockTabsDemo />
      </Section>

      <Section id="plans" title="Plans, tasks, queues">
        <Plan
          steps={[
            { id: "p1", label: "Land lanes", status: "done" },
            { id: "p2", label: "Integrate", status: "active" },
          ]}
        />
        <Plan defaultOpen>
          <PlanHeader>
            <PlanTitle>Compound plan</PlanTitle>
            <PlanDescription>Plan rendered from anatomy.</PlanDescription>
          </PlanHeader>
          <PlanContent>
            <PlanStep label="Compose css" status="done" />
          </PlanContent>
        </Plan>
        <Queue data-testid="queue">
          <QueueSection defaultOpen>
            <QueueSectionTrigger>
              <QueueSectionLabel label="Pending" count={1} />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                <QueueItem status="running">
                  <QueueItemIndicator status="running" />
                  <QueueItemContent>
                    Regenerate docs bundles
                    <QueueItemDescription>After docs edits land.</QueueItemDescription>
                  </QueueItemContent>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
        <ActivityTimeline
          items={[
            { id: "e1", kind: "tool", title: "edit packages/ui/src/index.ts", timestampMs: 1_700_000_000_000 },
            { id: "e2", kind: "message", title: "reported status", timestampMs: 1_700_000_100_000 },
          ]}
        />
        <ActivityTimeline>
          <ActivityGroup label="Earlier">
            <ActivityItem kind="message" title="run started" timestampMs={1_700_000_000_000} />
          </ActivityGroup>
        </ActivityTimeline>
        <p>
          Planned as Task/TaskTrigger/TaskContent/TaskGroup; shipped as AgentTask/AgentTaskTrigger/
          AgentTaskContent/AgentTaskGroup per the frozen collision policy.
        </p>
        <AgentTaskGroup data-testid="agent-task-group">
          <AgentTask title="Merge lane barrels" status="running" defaultOpen>
            <AgentTaskTrigger aria-label="Toggle merge lane barrels" />
            <AgentTaskContent>
              <TaskItem
                data-testid="task-item"
                label="Compose lane CSS"
                status="complete"
                files={["packages/ui/src/uiCss.ts"]}
                elapsedSeconds={95}
              />
              <TaskItem label="Aggregate provenance" status="running" elapsedSeconds={12}>
                <TaskItemFile name="shadcn-provenance.json" />
              </TaskItem>
            </AgentTaskContent>
          </AgentTask>
          <AgentTask title="Regenerate docs bundles" status="pending">
            <AgentTaskTrigger aria-label="Toggle regenerate docs bundles" />
            <AgentTaskContent>
              <TaskItem label="pnpm docs:llms" status="pending" />
            </AgentTaskContent>
          </AgentTask>
        </AgentTaskGroup>
      </Section>

      <Section id="approvals" title="Approvals and checkpoints">
        <ApprovalDemo />
        <CheckpointDemo />
      </Section>

      <Section id="sources" title="Sources and citations">
        <Sources>
          <SourcesTrigger>2 sources</SourcesTrigger>
          <SourcesContent>
            <Source title="Integration contract" href="https://example.com/contract" domain="example.com" />
            <Source title="Guard source" href="https://example.com/guard" domain="example.com" />
          </SourcesContent>
        </Sources>
        <p>
          As recorded in the contract
          <InlineCitation href="https://example.com/contract" index={1} label="Integration contract" />
          .
        </p>
        <CitationCarousel sources={[CITATION_SOURCE]} />
        <CitationCard source={CITATION_SOURCE} />
        <CitationQuote quote="Keep both EOF blocks." />
        <SuggestionGroup>
          <Suggestion suggestion="Show the diff" onClick={() => {}} />
          <Suggestion suggestion="Run the tests" onClick={() => {}} />
        </SuggestionGroup>
        <OpenInChat subject={{ kind: "run", label: "agui run", ref: "run-1784654981789" }} onOpen={() => {}} />
      </Section>

      <Section id="agents" title="Agents and context">
        <p>Planned as Agent; shipped as AgentDefinition per the frozen collision policy.</p>
        <AgentDefinition name="implementer" availability="available">
          <AgentHeader />
          <AgentContent>
            <AgentInstructions text="Implement the task, then verify with tests." />
            <AgentTools>
              <AgentTool tool={{ name: "bash", description: "Run shell commands" }} />
            </AgentTools>
            <AgentOutputSchema schema={{ type: "object", properties: { summary: { type: "string" } } }} />
          </AgentContent>
        </AgentDefinition>
        <AgentCard name="reviewer" description="Reviews diffs for correctness" model="claude-opus-4-8" />
        <ModelSelector data-testid="model-selector" options={MODEL_OPTIONS} defaultValue="claude-opus-4-8" />
        <div style={{ display: "flex", gap: 8 }}>
          <ModelBadge model="claude-opus-4-8" provider="anthropic" />
          <ProviderBadge provider="openai" />
        </div>
        <ContextUsage
          usage={{
            usedTokens: 131_700,
            maxTokens: 200_000,
            inputTokens: 120_400,
            outputTokens: 8_200,
            reasoningTokens: 3_100,
            cachedInputTokens: 40_000,
          }}
        >
          <ContextTrigger />
          <ContextContent>
            <ContextContentHeader />
            <ContextContentBody>
              <ContextInputUsage />
              <ContextOutputUsage />
              <ContextReasoningUsage />
              <ContextCacheUsage />
            </ContextContentBody>
            <ContextContentFooter />
          </ContextContent>
        </ContextUsage>
      </Section>

      <Section id="artifacts" title="Coding artifacts">
        <Artifact data-testid="artifact">
          <ArtifactHeader>
            <ArtifactTitle>integration.patch</ArtifactTitle>
            <ArtifactDescription>Barrel and css composition</ArtifactDescription>
            <ArtifactActions>
              <ArtifactClose onClose={() => {}} />
            </ArtifactActions>
          </ArtifactHeader>
          <ArtifactContent>patch body</ArtifactContent>
        </Artifact>
        <Snippet code="pnpm -C packages/ui test" language="bash" />
        <PackageInfo name="@smithers-orchestrator/ui" version="0.29.0" />
        <SchemaDisplay schema={{ type: "object", properties: { laneId: { type: "string" } } }} />
        <Commit
          commit={{
            hash: "ad1bec3d3588e6ba25c8f885d81d82d166058526",
            message: "land workflow-canvas lane",
            author: "integration",
            timestampMs: 1_700_000_000_000,
          }}
        >
          <CommitHeader>
            <CommitAuthor />
            <CommitMessage />
            <CommitMetadata>
              <CommitHash hash="ad1bec3d3588e6ba25c8f885d81d82d166058526" />
              <CommitTimestamp timestampMs={1_700_000_000_000} />
            </CommitMetadata>
          </CommitHeader>
          <CommitFiles>
            <CommitFile file={{ path: "packages/ui/src/index.ts", status: "modified" }} />
          </CommitFiles>
        </Commit>
        <ChangeSummary additions={210} deletions={12} filesChanged={3} />
        <EnvironmentVariables
          variables={[
            { name: "SMITHERS_GATEWAY", value: "http://127.0.0.1:7331" },
            { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret", secret: true },
          ]}
        />
        <EnvironmentVariable name="INLINE_SECRET" value="hunter2" secret />
        <SecretField value="hunter2" />
      </Section>

      <Section id="test-results" title="Test results and stack traces">
        <p>Planned as Test; shipped as TestRow per the frozen collision policy.</p>
        <div data-testid="test-results-demo" style={{ display: "grid", gap: 12 }}>
          <TestResults suites={FAILING_SUITES} />
          <StackTrace data-testid="stack-trace" raw={STACK} defaultOpen />
        </div>
      </Section>

      <Section id="sandbox" title="Sandbox previews">
        <AgentSandbox state="ready">
          <AgentSandboxHeader>
            <AgentSandboxStatus state="ready" />
            <AgentSandboxActions onReconnect={() => {}} />
          </AgentSandboxHeader>
          <AgentSandboxContent>Sandbox ready.</AgentSandboxContent>
        </AgentSandbox>
        <WebPreview defaultUrl="https://preview.smithers.local">
          <WebPreviewToolbar>
            <WebPreviewAddress aria-label="Preview URL" />
          </WebPreviewToolbar>
          <WebPreviewContent title="Sandbox preview" />
        </WebPreview>
        <JSXPreview node={<div>inert preview</div>} />
      </Section>

      <Section id="canvas" title="Workflow canvas">
        <WorkflowCanvas data-testid="workflow-canvas" style={{ minHeight: 200 }}>
          <WorkflowPanel position="top-left">agui/run-1784654981789</WorkflowPanel>
          <WorkflowToolbar aria-label="Canvas actions" />
          <WorkflowNode title="merge lanes" status="complete" data-node-id="merge">
            <WorkflowNodeHeader>merge lanes</WorkflowNodeHeader>
            <WorkflowNodeContent>
              <WorkflowNodeStatus status="complete" />
            </WorkflowNodeContent>
          </WorkflowNode>
          <WorkflowNode title="integrate" status="running" data-node-id="integrate">
            <WorkflowNodeHeader>integrate</WorkflowNodeHeader>
            <WorkflowNodeContent>
              <WorkflowNodeStatus status="running" />
            </WorkflowNodeContent>
          </WorkflowNode>
          <WorkflowEdge from="merge" to="integrate" status="complete" label="then" />
          <WorkflowConnection status="valid" />
          <WorkflowControls onZoomIn={() => {}} onZoomOut={() => {}} onFitView={() => {}} />
          <WorkflowMinimap />
        </WorkflowCanvas>
      </Section>
    </div>
  );
}
