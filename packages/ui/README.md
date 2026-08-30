# @smthrs/ui

Shared component library for Smithers UIs: shadcn component anatomy (compound
slots, CVA variant APIs, `asChild`, `data-slot` attributes) and Radix behavior,
styled entirely through theme tokens so every component is correct in light and
dark and honors `prefers-reduced-motion`.

Styling ships as CSS-in-TS (`smithersUiCss`) because the gateway UI bundler
drops `.css` imports. Render `<SmithersUiStyles />` once at the root; every
component also self-injects the composed sheet plus its lane CSS fragment as a
fallback. All classes are namespaced `sui-*`.

```tsx
import { SmithersUiStyles, Button, StatusPill } from "@smthrs/ui";
```

## Families

- Base primitives: `Button`, `Badge`, `Card`, `Input`, `Label`, `Alert`,
  `Table`, `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`,
  `Skeleton`, `Spinner`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`,
  `StageStrip`, `CollapsiblePanel`, `DiffHunks`, `FileTree`, `Markdown`.
- Conversation: `Message` family, `MessageBranch` family, `Bubble` family,
  `MessageScroller` (drop-in and compound anatomy plus hooks), `CompactGroup`,
  `ConversationCheckpoint`, `ChatMessage`, `ChatTranscript`, `ChatComposer`,
  `Marker`, `Shimmer`.
- Prompt and attachments: `PromptInput` family with
  `usePromptInputAttachments`, and the `Attachment` compound.
- Reasoning and tools: `Reasoning`, `ChainOfThought`, `ToolCall`, `CodeBlock`
  (with header/filename/group/tabs), `AgentOutput`, `MessageResponse`,
  `parseAgentOutput`, `formatPartialJson`.
- Plans, tasks, queues: `Plan` family, `TaskItem`, `AgentTask` family,
  `Queue` family, `ActivityTimeline`.
- Approvals and checkpoints: `Confirmation` family, `ApprovalCard`,
  `Checkpoint` family.
- Sources and citations: `Sources`, `InlineCitation` with card/carousel/quote,
  `Suggestion`, `OpenInChat`.
- Agents and context: `AgentDefinition`, `AgentCard`, `ModelSelector`,
  `ModelBadge`, `ProviderBadge`, `ContextUsage` family.
- Coding artifacts: `Artifact`, `Snippet`, `PackageInfo`, `SchemaDisplay`,
  `StackTrace`, `TestResults`, `Commit`, `ChangeSummary`,
  `EnvironmentVariables`, `SecretField`.
- Sandbox previews: `Sandbox`/`SandboxHeader`/`SandboxStatus`/`SandboxActions`/`SandboxContent` (also exported as `AgentSandbox*` for back-compat), `WebPreview`, `JSXPreview`.
- Workflow canvas: `WorkflowCanvas` node/edge/controls/panel/toolbar/minimap
  anatomy.

Heavy renderers stay behind `smthrs/ui/adapters/*` subpaths so
the base barrel tree-shakes clean. Gateway-bound wrappers
(`GatewayApprovalList`, `GatewayApprovalConfirmation`,
`GatewayCheckpointControls`, `SmithersCanvasNode`) live in
`smthrs/gateway-ui`.

Provenance for every ported family is recorded per lane under `provenance/`
and aggregated in `shadcn-provenance.json`; `node scripts/check-ui-architecture.mjs`
enforces the catalog.
