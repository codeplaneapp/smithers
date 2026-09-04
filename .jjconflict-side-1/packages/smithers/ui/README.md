# @smthrs/ui

**Documentation:** https://ui.smithers.sh

Shared component library for Smithers UIs: shadcn component anatomy (compound
slots, CVA variant APIs, `asChild`, `data-slot` attributes) and Radix behavior,
styled entirely through theme tokens so every component is correct in light and
dark and honors `prefers-reduced-motion`.

`@smthrs/ui` is `private: true` and workspace-only at `1.0.0-rc.0`. It is not
published to any registry: `apps/ui` and `apps/review` consume it through the
workspace.
Import it by its scoped name, `@smthrs/ui`; the unscoped `smthrs` package
publishes only a deprecation notice whose module throws on import.

Styling ships as CSS-in-TS (`smithersUiCss`) because the bundler this package
is built for drops `.css` imports. Render `<SmithersUiStyles />` once at the
root; every component also self-injects the composed sheet plus its lane CSS
fragment as a fallback. All classes are namespaced `sui-*`.

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
- Sandbox previews: `Sandbox`/`SandboxHeader`/`SandboxStatus`/`SandboxActions`/`SandboxContent`
  (also exported as `AgentSandbox*` for back-compat), `WebPreview`, `JSXPreview`.
- Workflow canvas: `WorkflowCanvas` node/edge/controls/panel/toolbar/minimap
  anatomy.
- Vault: `BacklinksPanel`, `OutlineView`, the `wikilinks` and `graphModel`
  helpers, and the `createAutosaveDoc` / `useAutosaveDoc` autosave machine.
- Time: `RelativeTime`, `useRelativeTime`, `formatRelativeTime`.
- Calendar: `Calendar` with month, week, and day views.

Heavy renderers stay behind `@smthrs/ui/adapters/*` subpaths so the base barrel
tree-shakes clean: `pierre-diff-view`, `code-view`, `terminal`, `markdown-editor`,
`chart`, `knowledge-graph`. `tests/barrel-weight.test.ts` is the ratchet that keeps them
out of `src/index.ts`.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — layering, file layout, the
  adapters rule, and the styling gotchas.
- [`docs/contracts.md`](./docs/contracts.md) — failure codes, resource limits,
  and the object-URL ownership rule.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- JSDoc on each exported symbol in `src/` is the API reference. There is no
  page for this package under `docs/pages` while it stays private; see
  [`docs/README.md`](./docs/README.md).

## Gates

```sh
pnpm --filter @smthrs/ui test    # bun test tests
pnpm --filter @smthrs/ui run check    # tsc -p tsconfig.json --noEmit
```

Both are declared in `PACKAGE.ts` as `//packages/smithers/ui:unitTests` and
`//packages/smithers/ui:check`. This package does not run vitest, coverage thresholds,
eslint or dprint; `PACKAGE.ts` records the package-specific tooling boundary.
