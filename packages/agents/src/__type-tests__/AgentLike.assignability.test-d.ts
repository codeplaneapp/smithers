import type {
  AgentLike,
  AmpAgent,
  AnthropicAgent,
  ClaudeCodeAgent,
  CodexAgent,
  ForgeAgent,
  GeminiAgent,
  KimiAgent,
  OpenAIAgent,
  PiAgent,
} from "../index.js";

type AssertAssignable<T extends AgentLike> = T;

type _CustomNativeStructuredAgent = AssertAssignable<{
  supportsNativeStructuredOutput: true;
  generate: () => Promise<unknown>;
}>;

type _ConcreteAgentsAreAgentLike = [
  AssertAssignable<AmpAgent>,
  AssertAssignable<AnthropicAgent>,
  AssertAssignable<ClaudeCodeAgent>,
  AssertAssignable<CodexAgent>,
  AssertAssignable<ForgeAgent>,
  AssertAssignable<GeminiAgent>,
  AssertAssignable<KimiAgent>,
  AssertAssignable<OpenAIAgent>,
  AssertAssignable<PiAgent>,
];
