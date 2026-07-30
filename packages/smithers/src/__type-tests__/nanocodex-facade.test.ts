import {
  NanocodexAgent,
  type AgentLike,
  type NanocodexAgentOptions,
  type NanocodexAuth,
  type NanocodexGenerateOptions,
} from "../index.js";

const auth: NanocodexAuth = { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY" };
const options: NanocodexAgentOptions = { auth, thinking: "xhigh", reasoningMode: "pro" };
const agent: AgentLike = new NanocodexAgent(options);
const _generateAcceptsNanocodexOptions = (target: NanocodexAgent, input: NanocodexGenerateOptions) =>
  target.generate(input);
void agent;

// @ts-expect-error protocol v1 does not expose custom endpoints through the facade
const invalid: NanocodexAgentOptions = { endpoint: "https://example.test" };
void invalid;
