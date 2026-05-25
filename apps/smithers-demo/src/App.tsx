import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  DEBATE_E2E_PROMPT,
  defaultModelForProvider,
  PROVIDER_OPTIONS,
  runDebateWorkflow,
} from "./cerebrasDebate.js";
import { generateSmithersCode, generateWorkflowFromPrompt, SMITHERS_CAPABILITY_PROMPT } from "./workflowModel";
import { validateLayout, workflowToFlow } from "./layout";
import type { SmithersFlowNode } from "./layout";
import "./styles.css";

const examples = [
  DEBATE_E2E_PROMPT,
  "Build a docs generator workflow with implementation, tests, validation, and release approval",
  "Research and audit a dependency update, implement the fix, then verify with tests",
];

function SmithersTaskNode({ data }: NodeProps<SmithersFlowNode>) {
  return (
    <div className={`smithers-node smithers-node-${data.kind}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kicker">{data.kind}</div>
      <div className="node-title">{data.label}</div>
      <div className="node-output">{data.output}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = {
  smithersTask: SmithersTaskNode,
};

type ProviderId = "cerebras" | "openai" | "anthropic";

type StoredSettings = {
  provider?: ProviderId;
  keys?: Partial<Record<ProviderId, string>>;
  models?: Partial<Record<ProviderId, string>>;
};

const SETTINGS_KEY = "smithers-demo-provider-settings";

function loadSettings(): Required<StoredSettings> {
  if (typeof window === "undefined") {
    return { provider: "cerebras", keys: {}, models: {} };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as StoredSettings;
    return {
      provider: parsed.provider ?? "cerebras",
      keys: parsed.keys ?? {},
      models: parsed.models ?? {},
    };
  } catch {
    return { provider: "cerebras", keys: {}, models: {} };
  }
}

function Studio() {
  const [draft, setDraft] = useState(examples[0]);
  const [prompt, setPrompt] = useState(examples[0]);
  const [settings, setSettings] = useState(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generationState, setGenerationState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [generationOutput, setGenerationOutput] = useState("");
  const [localGenerationCount, setLocalGenerationCount] = useState(0);
  const provider = settings.provider;
  const apiKey = settings.keys[provider] ?? "";
  const model = settings.models[provider] || defaultModelForProvider(provider);
  const spec = useMemo(() => generateWorkflowFromPrompt(prompt), [prompt]);
  const code = useMemo(() => generateSmithersCode(spec), [spec]);
  const flow = useMemo(() => workflowToFlow(spec), [spec]);
  const validation = useMemo(() => validateLayout(flow.nodes), [flow.nodes]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  function updateProvider(providerId: ProviderId) {
    setSettings((current) => ({
      ...current,
      provider: providerId,
      models: {
        ...current.models,
        [providerId]: current.models[providerId] || defaultModelForProvider(providerId),
      },
    }));
  }

  function updateApiKey(value: string) {
    setSettings((current) => ({
      ...current,
      keys: {
        ...current.keys,
        [current.provider]: value,
      },
    }));
  }

  function updateModel(value: string) {
    setSettings((current) => ({
      ...current,
      models: {
        ...current.models,
        [current.provider]: value,
      },
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrompt(draft);
    setLocalGenerationCount((count) => count + 1);
    setGenerationState("idle");
    setGenerationOutput(
      `Generated local Smithers graph and code for ${draft.length} characters.\n\nCapability prompt in use:\n${SMITHERS_CAPABILITY_PROMPT}`,
    );
  }

  async function runWithProvider() {
    setPrompt(draft);
    setGenerationState("running");
    setGenerationOutput(`Running ${PROVIDER_OPTIONS[provider].label} debate loop with ${model}...`);
    try {
      const result = await runDebateWorkflow({
        apiKey,
        provider,
        model,
        prompt: draft,
        rounds: 2,
        onStep: (step: { role: string; status: string; content?: string }) => {
          if (step.status === "complete") {
            setGenerationOutput((current) => `${current}\n\n[${step.role}]\n${step.content}`);
          }
        },
      });
      setGenerationState("done");
      setGenerationOutput(
        `${result.transcript.map((entry) => `[${entry.role}]\n${entry.content}`).join("\n\n")}\n\n[final]\n${result.finalResult}`,
      );
    } catch (error) {
      setGenerationState("error");
      setGenerationOutput(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Smithers demo</p>
          <h1>Workflow Studio</h1>
        </div>
        <div className="local-status" aria-live="polite">
          {localGenerationCount === 0
            ? "Local generation updates the graph and Smithers React code immediately."
            : `Local generation updated ${localGenerationCount} time${localGenerationCount === 1 ? "" : "s"}.`}
        </div>
        <button className="settings-toggle" type="button" onClick={() => setSettingsOpen((open) => !open)}>
          Settings
        </button>
        {settingsOpen ? (
          <div className="settings-panel" aria-label="Provider settings">
            <label>
              <span>Provider</span>
              <select
                aria-label="Provider"
                value={provider}
                onChange={(event) => updateProvider(event.target.value as ProviderId)}
              >
                <option value="cerebras">Cerebras</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Claude</option>
              </select>
            </label>
            <label>
              <span>API key</span>
              <input
                aria-label="Provider API key"
                type="password"
                value={apiKey}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder={PROVIDER_OPTIONS[provider].envVar}
              />
            </label>
            <label>
              <span>Model</span>
              <input
                aria-label="Provider model"
                value={model}
                onChange={(event) => updateModel(event.target.value)}
                placeholder={defaultModelForProvider(provider)}
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="workspace">
        <div className="graph-pane" aria-label="Generated workflow graph">
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.35}
          >
            <Background gap={26} color="#e2e7ef" />
            <Controls />
          </ReactFlow>
        </div>

        <aside className="code-pane">
          <div className="code-header">
            <div>
              <p className="eyebrow">Generated Smithers React code</p>
              <h2>{spec.name}</h2>
            </div>
            <span className={validation.valid ? "status-ok" : "status-error"}>
              {validation.valid ? "layout valid" : "layout overlap"}
            </span>
          </div>
          <pre>
            <code>{code}</code>
          </pre>
          <section className={`generation-output generation-${generationState}`} aria-label="Generation output">
            <p className="eyebrow">{generationState === "idle" ? "Generation feedback" : "Provider output"}</p>
            <div>{generationOutput || "Enter an API key in Settings and run the workflow to generate live output."}</div>
          </section>
        </aside>
      </section>

      <section className="bottom-composer" aria-label="Prompt composer">
        <form className="chat-form" onSubmit={submit}>
          <input
            aria-label="Workflow prompt"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Describe the Smithers workflow to generate"
          />
          <button type="submit">Generate</button>
          <button type="button" disabled={generationState === "running"} onClick={runWithProvider}>
            Run Workflow
          </button>
        </form>
        <div className="prompt-row" aria-label="Example prompts">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setDraft(example);
              setPrompt(example);
            }}
          >
            {example}
          </button>
        ))}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}
