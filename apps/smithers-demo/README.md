# Smithers Workflow Studio Demo

This app demonstrates a React Flow-powered Smithers workflow studio. A prompt drives a generated workflow model, the model is rendered as a left-side node graph, and the matching Smithers React workflow code is shown on the right.

## Run

```bash
pnpm --filter @smithers-orchestrator/smithers-demo dev
```

The Vite dev server opens on `http://127.0.0.1:5174` when the port is available.

## React TUI + Cerebras

The terminal demo uses `@dino-dna/react-tui` with `neo-blessed` and renders the generated workflow as a connected 2D node graph. It runs the same provider-backed debate workflow as the browser app:

```bash
pnpm --filter @smithers-orchestrator/smithers-tui-demo tui
```

Start it with one provider key set (`CEREBRAS_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`). The prompt input at the bottom regenerates the graph locally. `Run Workflow` switches the graph into running state, changes the action to `Cancel`, and shows `Done` after the provider workflow finishes. The default prompt is:

```text
Do a loop where you have two LMs debate communism versus capitalism and then have a judge LM output a final result.
```

For a non-interactive live provider check, set one provider key and run:

```bash
CEREBRAS_API_KEY=... pnpm --filter @smithers-orchestrator/smithers-demo cerebras:debate
OPENAI_API_KEY=... pnpm --filter @smithers-orchestrator/smithers-demo cerebras:debate
ANTHROPIC_API_KEY=... pnpm --filter @smithers-orchestrator/smithers-demo cerebras:debate
```

The browser app stores provider, model, and key settings in local browser settings. Defaults are Cerebras `gpt-oss-120b`, OpenAI `gpt-5.5`, and Claude `claude-opus-4.7`.

## Validate

```bash
pnpm --filter @smithers-orchestrator/smithers-demo test
pnpm --filter @smithers-orchestrator/smithers-demo build
pnpm --filter @smithers-orchestrator/smithers-demo e2e
pnpm --filter @smithers-orchestrator/smithers-tui-demo test
```

The layout tests assert that generated React Flow nodes do not overlap. The Playwright e2e test runs the real Workflow Studio in desktop and mobile viewports, verifies settings persistence, regenerates the graph from the bottom prompt composer, confirms provider-neutral `Run Workflow` copy, stubs provider output, and checks rendered React Flow nodes do not overlap. The TUI tests assert that terminal graph nodes render in 2D space with connections, do not overlap, and expose the Run Workflow -> Cancel -> Done state contract. The browser app also validates the generated layout in the UI and surfaces a `layout valid` or `layout overlap` badge beside the generated Smithers code.
