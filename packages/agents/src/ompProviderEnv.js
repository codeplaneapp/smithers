const OMP_PROVIDER_ENV = new Map([
  ["openai", "OPENAI_API_KEY"], ["openai-codex", "OPENAI_API_KEY"], ["azure", "AZURE_OPENAI_API_KEY"], ["azure-openai", "AZURE_OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"], ["claude", "ANTHROPIC_API_KEY"], ["google", "GEMINI_API_KEY"], ["gemini", "GEMINI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"], ["groq", "GROQ_API_KEY"], ["mistral", "MISTRAL_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"],
  ["xai", "XAI_API_KEY"], ["grok", "XAI_API_KEY"], ["cerebras", "CEREBRAS_API_KEY"], ["moonshot", "MOONSHOT_API_KEY"],
  ["kimi", "MOONSHOT_API_KEY"], ["minimax", "MINIMAX_API_KEY"], ["zai", "ZAI_API_KEY"], ["zhipuai", "ZAI_API_KEY"],
  ["fireworks", "FIREWORKS_API_KEY"], ["together", "TOGETHER_API_KEY"], ["huggingface", "HF_TOKEN"], ["hf", "HF_TOKEN"],
  ["nvidia", "NVIDIA_API_KEY"], ["litellm", "LITELLM_API_KEY"], ["qianfan", "QIANFAN_API_KEY"],
  ["perplexity", "PERPLEXITYAI_API_KEY"], ["cohere", "COHERE_API_KEY"], ["deepinfra", "DEEPINFRA_API_KEY"],
  ["sambanova", "SAMBANOVA_API_KEY"], ["siliconflow", "SILICONFLOW_API_KEY"], ["replicate", "REPLICATE_API_TOKEN"],
  ["volcengine", "ARK_API_KEY"], ["baichuan", "BAICHUAN_API_KEY"], ["yi", "YI_API_KEY"], ["upstage", "UPSTAGE_API_KEY"],
  ["novita", "NOVITA_API_KEY"], ["friendli", "FRIENDLI_TOKEN"], ["ai21", "AI21_API_KEY"], ["aleph-alpha", "ALEPH_ALPHA_API_KEY"],
  ["watsonx", "WATSONX_APIKEY"], ["databricks", "DATABRICKS_TOKEN"], ["custom", "OPENAI_API_KEY"],
]);

/** @param {string | undefined} provider @param {string | undefined} model @returns {string | undefined} */
export function resolveOmpProviderEnv(provider, model) {
  const explicitProvider = String(provider ?? "").trim().toLowerCase();
  if (explicitProvider) return OMP_PROVIDER_ENV.get(explicitProvider);
  const value = String(model ?? "").toLowerCase();
  if (/\b(?:gpt|o[1-9]|text-embedding)/.test(value)) return "OPENAI_API_KEY";
  if (/\b(?:claude|sonnet|haiku|opus)/.test(value)) return "ANTHROPIC_API_KEY";
  if (/\b(?:gemini|gemma)/.test(value)) return "GEMINI_API_KEY";
  for (const [alias, envName] of OMP_PROVIDER_ENV) {
    if (value.split(/[/:\s-]+/).includes(alias) || value.includes(`${alias}/`)) return envName;
  }
  return undefined;
}
