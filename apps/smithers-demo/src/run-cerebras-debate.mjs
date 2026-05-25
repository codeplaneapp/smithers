import { DEBATE_E2E_PROMPT, defaultModelForProvider, PROVIDER_OPTIONS, runDebateWorkflow } from "./cerebrasDebate.js";

const provider = process.env.OPENAI_API_KEY
  ? "openai"
  : process.env.ANTHROPIC_API_KEY
    ? "anthropic"
    : "cerebras";
const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.CEREBRAS_API_KEY;
const model = process.env.SMITHERS_MODEL ?? defaultModelForProvider(provider);
const rounds = Number(process.env.CEREBRAS_DEBATE_ROUNDS ?? "2");

if (!apiKey) {
  console.error(
    `Set one provider key before running: ${Object.values(PROVIDER_OPTIONS)
      .map((option) => option.envVar)
      .join(", ")}.`,
  );
  process.exit(1);
}

const result = await runDebateWorkflow({
  apiKey,
  provider,
  model,
  rounds,
  prompt: DEBATE_E2E_PROMPT,
  onStep: (step) => {
    if (step.status === "complete") {
      console.log(`\n[${step.role}]\n${step.content}`);
    }
  },
});

console.log("\n[final-result]");
console.log(result.finalResult);
