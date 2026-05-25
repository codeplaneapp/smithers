const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export const DEFAULT_CEREBRAS_MODEL = "gpt-oss-120b";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4.7";
export const DEBATE_E2E_PROMPT =
  "Do a loop where you have two LMs debate communism versus capitalism and then have a judge LM output a final result.";

export const PROVIDER_OPTIONS = {
  cerebras: {
    label: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    defaultModel: DEFAULT_CEREBRAS_MODEL,
  },
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  anthropic: {
    label: "Claude",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  },
};

/**
 * @typedef {"cerebras" | "openai" | "anthropic"} ProviderId
 * @typedef {{ role: string; content: string }} DebateEntry
 * @typedef {{ role: string; status: "running" | "complete"; content?: string }} DebateStep
 * @typedef {{
 *   apiKey: string;
 *   provider?: ProviderId;
 *   model?: string;
 *   messages: Array<{ role: string; content: string }>;
 *   temperature?: number;
 *   signal?: AbortSignal;
 *   fetchImpl?: typeof fetch;
 * }} ProviderChatArgs
 * @typedef {(args: ProviderChatArgs) => Promise<string>} ProviderChat
 * @typedef {{
 *   apiKey: string;
 *   provider?: ProviderId;
 *   model?: string;
 *   prompt?: string;
 *   rounds?: number;
 *   signal?: AbortSignal;
 *   chat?: ProviderChat;
 *   onStep?: (step: DebateStep) => void;
 * }} DebateWorkflowArgs
 * @typedef {{
 *   prompt: string;
 *   provider: ProviderId;
 *   model: string;
 *   rounds: number;
 *   transcript: DebateEntry[];
 *   finalResult: string;
 * }} DebateWorkflowResult
 */

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function normalizeProvider(provider) {
  if (provider === "openai" || provider === "anthropic" || provider === "cerebras") return provider;
  return "cerebras";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Workflow cancelled");
  }
}

export function defaultModelForProvider(provider) {
  return PROVIDER_OPTIONS[normalizeProvider(provider)]?.defaultModel ?? DEFAULT_CEREBRAS_MODEL;
}

function extractContent(responseJson, provider) {
  const choice = responseJson?.choices?.[0];
  const message = choice?.message;
  const content =
    message?.content ??
    message?.reasoning_content ??
    message?.reasoning ??
    choice?.text ??
    responseJson?.output_text;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`${PROVIDER_OPTIONS[provider].label} response did not include message content`);
  }
  return content;
}

/** @param {ProviderChatArgs} args */
export async function callProviderChat({
  apiKey,
  provider = "cerebras",
  model,
  messages,
  temperature = 0.4,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const selectedProvider = normalizeProvider(provider);
  const selectedModel = model || defaultModelForProvider(selectedProvider);
  const key = assertNonEmpty(apiKey, `${PROVIDER_OPTIONS[selectedProvider].label} API key`);
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }
  throwIfAborted(signal);

  if (selectedProvider === "anthropic") {
    const system = messages.find((message) => message.role === "system")?.content;
    const anthropicMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));

    const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        system,
        messages: anthropicMessages,
        temperature,
        max_tokens: 1200,
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Claude request failed (${response.status}): ${responseText}`);
    }
    const parsed = JSON.parse(responseText);
    const content = parsed?.content?.find((part) => part?.type === "text")?.text;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("Claude response did not include text content");
    }
    return content;
  }

  const response = await fetchImpl(selectedProvider === "openai" ? OPENAI_CHAT_URL : CEREBRAS_CHAT_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages,
      temperature,
      max_completion_tokens: 1200,
      ...(selectedProvider === "cerebras" ? { reasoning_effort: "low" } : {}),
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${PROVIDER_OPTIONS[selectedProvider].label} request failed (${response.status}): ${responseText}`);
  }

  return extractContent(JSON.parse(responseText), selectedProvider);
}

export const callCerebrasChat = (args) => callProviderChat({ ...args, provider: "cerebras" });

/**
 * @param {DebateWorkflowArgs} args
 * @returns {Promise<DebateWorkflowResult>}
 */
export async function runDebateWorkflow({
  apiKey,
  provider = "cerebras",
  model,
  prompt = DEBATE_E2E_PROMPT,
  rounds = 2,
  signal,
  chat = callProviderChat,
  onStep,
}) {
  const selectedProvider = normalizeProvider(provider);
  const selectedModel = model || defaultModelForProvider(selectedProvider);
  const debatePrompt = assertNonEmpty(prompt, "Debate prompt");
  const transcript = [];

  async function ask(role, system, user) {
    throwIfAborted(signal);
    onStep?.({ role, status: "running" });
    const content = await chat({
      apiKey,
      provider: selectedProvider,
      model: selectedModel,
      signal,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    throwIfAborted(signal);
    const entry = { role, content };
    transcript.push(entry);
    onStep?.({ role, status: "complete", content });
    return content;
  }

  let context = debatePrompt;
  for (let round = 1; round <= rounds; round += 1) {
    const capitalism = await ask(
      `capitalism-round-${round}`,
      "You are one language model in a structured debate. Argue for capitalism with concrete claims, acknowledge tradeoffs, and respond directly to the opposing side. Return only the visible debate answer.",
      `Round ${round}. Debate task: ${debatePrompt}\n\nTranscript so far:\n${context}`,
    );
    context += `\n\nCapitalism LM round ${round}:\n${capitalism}`;

    const communism = await ask(
      `communism-round-${round}`,
      "You are one language model in a structured debate. Argue for communism with concrete claims, acknowledge tradeoffs, and respond directly to the opposing side. Return only the visible debate answer.",
      `Round ${round}. Debate task: ${debatePrompt}\n\nTranscript so far:\n${context}`,
    );
    context += `\n\nCommunism LM round ${round}:\n${communism}`;
  }

  const finalResult = await ask(
    "judge-final",
    "You are a neutral judge language model. Evaluate the debate fairly and output a final result with winner, reasoning, and caveats. Return only the visible final judgment.",
    `Judge this debate and output the final result.\n\nOriginal task:\n${debatePrompt}\n\nTranscript:\n${context}`,
  );

  return {
    prompt: debatePrompt,
    provider: selectedProvider,
    model: selectedModel,
    rounds,
    transcript,
    finalResult,
  };
}
