import type {
  AgentCheckpoint,
  AgentCheckpointCapability,
  AgentCheckpointFormat,
  AgentCheckpointJsonValue,
  AgentCheckpointPublisher,
} from "../AgentCheckpoint";
import type { AgentLike } from "../AgentLike";
import type { AgentCheckpointContinuationOptions, AgentGenerateOptions } from "../BaseCliAgent/AgentGenerateOptions";
import type {
  AmpAgent,
  AntigravityAgent,
  AnthropicAgent,
  ClaudeCodeAgent,
  CodexAgent,
  CursorAgent,
  ForgeAgent,
  GeminiAgent,
  KimiAgent,
  NanocodexAgent,
  OpenAIAgent,
  PiAgent,
} from "../index.js";

type _ContinuationOptionsArePublicSourceType = AgentCheckpointContinuationOptions;

const checkpoint = {
  codec: "example/session",
  version: 1,
  payload: { cursor: "next" },
} satisfies AgentCheckpoint;

const generateOptions = {
  resumeCheckpoint: checkpoint,
  checkpointMode: "fork",
} satisfies AgentGenerateOptions;

const jsonPayload = {
  cursor: [1, "next", true, null, { nested: 2 }],
} satisfies AgentCheckpointJsonValue;

const publish: AgentCheckpointPublisher = async (nextCheckpoint) => {
  void nextCheckpoint;
};

const publishingOptions = { onCheckpoint: publish } satisfies AgentGenerateOptions;
const boundedCheckpointOptions = { maxAgentCheckpointBytes: 1024 } satisfies AgentGenerateOptions;
declare const checkpointBoundedGenerateOptions: AgentGenerateOptions;
const effectiveCheckpointLimit: number | undefined = checkpointBoundedGenerateOptions.maxAgentCheckpointBytes;
// @ts-expect-error checkpoint ceilings are byte counts
const invalidCheckpointLimit: AgentGenerateOptions = { maxAgentCheckpointBytes: "1024" };

// @ts-expect-error checkpoint continuation requires an explicit mode
const missingCheckpointMode: AgentGenerateOptions = { resumeCheckpoint: checkpoint };
// @ts-expect-error mode cannot be supplied without a checkpoint
const modeWithoutCheckpoint: AgentGenerateOptions = { checkpointMode: "resume" };
const conflictingContinuation: AgentGenerateOptions = {
  resumeSession: "session-1",
  resumeCheckpoint: checkpoint,
  // @ts-expect-error native sessions and portable checkpoints are mutually exclusive
  checkpointMode: "resume",
};
// @ts-expect-error checkpoint payloads must be recursively JSON serializable
const invalidPayload: AgentCheckpoint = { codec: "x", version: 1, payload: { missing: undefined } };
// @ts-expect-error publication fences must be awaitable
const synchronousPublisher: AgentCheckpointPublisher = () => undefined;

void generateOptions;
void jsonPayload;
void publishingOptions;
void boundedCheckpointOptions;
void effectiveCheckpointLimit;
void invalidCheckpointLimit;
void missingCheckpointMode;
void modeWithoutCheckpoint;
void conflictingContinuation;
void invalidPayload;
void synchronousPublisher;

type AssertAssignable<T extends AgentLike> = T;

type _CustomNativeStructuredAgent = AssertAssignable<{
  supportsNativeStructuredOutput: true;
  checkpointCapabilities: readonly [AgentCheckpointCapability];
  checkpointFormats: readonly [AgentCheckpointFormat];
  generate: () => Promise<unknown>;
}>;

type _ConcreteAgentsAreAgentLike = [
  AssertAssignable<AmpAgent>,
  AssertAssignable<AntigravityAgent>,
  AssertAssignable<AnthropicAgent>,
  AssertAssignable<ClaudeCodeAgent>,
  AssertAssignable<CodexAgent>,
  AssertAssignable<CursorAgent>,
  AssertAssignable<ForgeAgent>,
  AssertAssignable<GeminiAgent>,
  AssertAssignable<KimiAgent>,
  AssertAssignable<NanocodexAgent>,
  AssertAssignable<OpenAIAgent>,
  AssertAssignable<PiAgent>,
];
