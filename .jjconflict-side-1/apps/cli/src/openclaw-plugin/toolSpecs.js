// Pure tool specifications and CLI-argument builders for the OpenClaw Smithers
// plugin. Kept free of the `openclaw` plugin SDK import (which only `index.js`
// needs) so the argument construction can be unit-tested directly.

const emptyParameters = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const toolSpecs = [
  {
    name: "smithers_run",
    description:
      "Start a durable Smithers workflow run. Use this for multi-step, long-running, crash-safe, human-in-the-loop, or retryable work instead of ad-hoc OpenClaw turns.",
    timeoutMs: 180_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow: { type: "string", description: "Workflow id, or a path to a .tsx workflow file." },
        prompt: { type: "string", description: "Plain-English prompt passed to the workflow." },
        input: { type: "object", description: "Structured JSON input passed as --input." },
        detach: { type: "boolean", description: "Run in the background. Defaults to true." },
      },
      required: ["workflow"],
    },
    toArgs(params) {
      const workflow = String(params.workflow ?? "").trim();
      if (!workflow) throw new Error("workflow is required");
      const isUp = workflow.endsWith(".tsx");
      const args = isUp ? ["up", workflow] : ["workflow", "run", workflow];
      const hasInput = isRecord(params.input) && Object.keys(params.input).length > 0;
      const hasPrompt = typeof params.prompt === "string" && params.prompt.trim().length > 0;
      // `up` has no --prompt flag; it only accepts --input JSON. `workflow run`
      // maps --prompt to input.prompt when --input is omitted. Route each to the
      // flag it actually supports so a prompt is never dropped or rejected.
      if (isUp) {
        if (hasInput) args.push("--input", JSON.stringify(params.input));
        else if (hasPrompt) args.push("--input", JSON.stringify({ prompt: params.prompt }));
      } else {
        if (hasPrompt) args.push("--prompt", params.prompt);
        if (hasInput) args.push("--input", JSON.stringify(params.input));
      }
      if (params.detach !== false) args.push("--detach");
      return args;
    },
  },
  {
    name: "smithers_create_workflow",
    description:
      "Create a new Smithers workflow from a plain-English description. Use this when no existing workflow fits a repeated or multi-step task.",
    timeoutMs: 180_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Description of the workflow to author, including inputs, done condition, and verification expectations.",
        },
        detach: { type: "boolean", description: "Run the create-workflow flow in the background. Defaults to true." },
      },
      required: ["prompt"],
    },
    toArgs(params) {
      const prompt = String(params.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt is required");
      const args = ["workflow", "run", "create-workflow", "--prompt", prompt];
      if (params.detach !== false) args.push("--detach");
      return args;
    },
  },
  {
    name: "smithers_ps",
    description: "List active, paused, and recently completed Smithers runs, including pending approval gates.",
    timeoutMs: 30_000,
    parameters: emptyParameters,
    toArgs() {
      return ["ps", "--json"];
    },
  },
  {
    name: "smithers_inspect",
    description: "Inspect one Smithers run: steps, agents, outputs, status, and pending approvals.",
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string", description: "Run id to inspect." },
      },
      required: ["run_id"],
    },
    toArgs(params) {
      const runId = String(params.run_id ?? "").trim();
      if (!runId) throw new Error("run_id is required");
      return ["inspect", runId, "--json"];
    },
  },
  {
    name: "smithers_approve",
    description: "Approve a paused Smithers approval gate after relaying the decision from the human.",
    timeoutMs: 60_000,
    parameters: decisionParameters(),
    toArgs(params) {
      return decisionArgs("approve", params);
    },
  },
  {
    name: "smithers_deny",
    description: "Deny a paused Smithers approval gate after relaying the decision from the human.",
    timeoutMs: 60_000,
    parameters: decisionParameters(),
    toArgs(params) {
      return decisionArgs("deny", params);
    },
  },
  {
    name: "smithers_output",
    description: "Print the structured output row for a specific node of a Smithers run.",
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string", description: "Run id." },
        node: { type: "string", description: "Node id to fetch output for (from smithers_inspect)." },
      },
      required: ["run_id", "node"],
    },
    toArgs(params) {
      const runId = String(params.run_id ?? "").trim();
      if (!runId) throw new Error("run_id is required");
      const node = String(params.node ?? "").trim();
      if (!node) throw new Error("node is required");
      // The CLI `output` command takes two positionals: <runId> <nodeId>. There
      // is no --node flag and no run-level form.
      return ["output", runId, node];
    },
  },
  {
    name: "smithers_human_answer",
    description: "Answer a blocking ask-human request raised by an agent inside a Smithers run.",
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        request_id: { type: "string", description: "Human request id." },
        value: { type: "string", description: "Answer value to deliver." },
      },
      required: ["request_id", "value"],
    },
    toArgs(params) {
      const requestId = String(params.request_id ?? "").trim();
      if (!requestId) throw new Error("request_id is required");
      if (params.value === undefined || params.value === null) throw new Error("value is required");
      return ["human", "answer", requestId, "--value", JSON.stringify(String(params.value))];
    },
  },
  {
    name: "smithers_eval",
    description:
      "Run a Smithers workflow over a JSON/JSONL eval suite. Use this before and after workflow prompt or logic changes.",
    timeoutMs: 30 * 60_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow: { type: "string", description: "Path to the workflow .tsx file." },
        cases: { type: "string", description: "JSON or JSONL eval case file." },
        suite: { type: "string", description: "Stable suite id." },
        report: { type: "string", description: "Report JSON output path." },
        dry_run: { type: "boolean", description: "Plan without launching runs." },
        concurrency: { type: "number", description: "Number of eval cases to run at once." },
        max_cases: { type: "number", description: "Run only the first N cases." },
        optimization: { type: "string", description: "Optimization artifact to apply during eval." },
      },
      required: ["workflow", "cases"],
    },
    toArgs(params) {
      const workflow = String(params.workflow ?? "").trim();
      if (!workflow) throw new Error("workflow is required");
      // The CLI `eval` command requires --cases (evalOptions.cases is not optional).
      const cases = String(params.cases ?? "").trim();
      if (!cases) throw new Error("cases is required");
      const args = ["eval", workflow, "--format", "json"];
      addString(args, "--cases", cases);
      addString(args, "--suite", params.suite);
      addString(args, "--report", params.report);
      addString(args, "--optimization", params.optimization);
      addNumber(args, "--concurrency", params.concurrency);
      addNumber(args, "--max-cases", params.max_cases);
      if (params.dry_run === true) args.push("--dry-run");
      return args;
    },
  },
  {
    name: "smithers_optimize",
    description:
      "Run GEPA prompt optimization for a Smithers workflow eval suite and write an optimization artifact.",
    timeoutMs: 45 * 60_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow: { type: "string", description: "Path to the workflow .tsx file." },
        cases: { type: "string", description: "JSON or JSONL eval case file." },
        suite: { type: "string", description: "Stable suite id." },
        provider: { type: "string", description: "Optimizer provider, e.g. claude-code, codex, openai-api, heuristic." },
        model: { type: "string", description: "Optimizer model." },
        artifact: { type: "string", description: "Path for the optimized prompt artifact." },
        report_dir: { type: "string", description: "Directory for baseline and optimized eval reports." },
        min_improvement: { type: "number", description: "Minimum required absolute score improvement." },
        concurrency: { type: "number", description: "Number of eval cases to run at once." },
        max_cases: { type: "number", description: "Run only the first N cases." },
      },
      required: ["workflow"],
    },
    toArgs(params) {
      const workflow = String(params.workflow ?? "").trim();
      if (!workflow) throw new Error("workflow is required");
      const args = ["optimize", workflow, "--format", "json"];
      addString(args, "--cases", params.cases);
      addString(args, "--suite", params.suite);
      addString(args, "--provider", params.provider);
      addString(args, "--model", params.model);
      addString(args, "--artifact", params.artifact);
      addString(args, "--report-dir", params.report_dir);
      addNumber(args, "--min-improvement", params.min_improvement);
      addNumber(args, "--concurrency", params.concurrency);
      addNumber(args, "--max-cases", params.max_cases);
      return args;
    },
  },
];

function decisionParameters() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      run_id: { type: "string", description: "Run id with the pending approval." },
      node: { type: "string", description: "Optional gate node id." },
      by: { type: "string", description: "Who made the decision." },
      note: { type: "string", description: "Optional reason." },
    },
    required: ["run_id"],
  };
}

function decisionArgs(verb, params) {
  const runId = String(params.run_id ?? "").trim();
  if (!runId) throw new Error("run_id is required");
  const args = [verb, runId];
  addString(args, "--node", params.node);
  addString(args, "--by", params.by);
  addString(args, "--note", params.note);
  return args;
}

function addString(args, flag, value) {
  if (typeof value === "string" && value.trim()) args.push(flag, value);
}

function addNumber(args, flag, value) {
  if (typeof value === "number" && Number.isFinite(value)) args.push(flag, String(value));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
