---
title: "@smthrs/ui"
description: "The shared component library for Smithers UIs: shadcn anatomy on Radix behavior, styled entirely through theme tokens, with every heavy renderer behind its own package subpath."
---

`@smthrs/ui` is the component library every Smithers browser UI renders. It is
shadcn/ui anatomy (compound slots, `data-slot` attributes, CVA variant APIs,
`asChild`) over Radix behavior, styled exclusively through the
[`@smthrs/ui-styleguide`](/api/ui-styleguide) theme tokens.

Two decisions shape everything else about it:

- **Styles travel as a JavaScript string.** There is no `.css` file to import.
  You render `<SmithersUiStyles />` once, and every component also injects the
  sheet itself in a browser as a fallback. The bundler this package targets
  drops CSS artifacts, so a string is the only delivery that survives.
- **Heavy renderers live behind their own subpaths.** Charts, terminals, syntax
  highlighting, and the markdown editor ship from `@smthrs/ui/adapters/*` and
  are never re-exported from the base barrel. A consumer who wants a `Button`
  does not pay for Shiki.

Because every color is a token expression rather than a literal, a component is
correct in light and dark with no dark-mode code, honors
`prefers-reduced-motion`, and follows whichever of the eight palettes the
document selects.

## Who uses this package

`apps/ui` and `apps/review` consume it through the workspace, and the
`create-app` templates render it in generated applications. It is
`private: true` at `1.0.0-rc.0` and published to no registry.

## Install

```json
{ "dependencies": { "@smthrs/ui": "workspace:*" } }
```

React 19 is a peer dependency. See [Installation](./installation.md) for the
entry points and the peer requirements.

## The shortest real example

```tsx
import { Button, Card, CardHeader, CardTitle, SmithersUiStyles, StatusPill } from "@smthrs/ui"

export function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <StatusPill status="running" />
        </CardHeader>
        <Button onClick={() => launch()}>Launch</Button>
      </Card>
    </>
  )
}
```

No color is named, no stylesheet is imported, and no dark-mode branch exists.
For the same surface built up end to end, see the
[Quickstart](./quickstart.md).

## The package at a glance

| Family                     | What it covers                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Base primitives            | `Button`, `Badge`, `Card`, `Input`, `Label`, `Alert`, `Table`, `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`, `Skeleton`, `Spinner` |
| House compositions         | `StatusPill`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`, `StageStrip`, `CollapsiblePanel`, `FileTree`, `Markdown`, `DiffHunks` |
| Conversation               | `Message`, `MessageBranch`, `Bubble`, `MessageScroller`, `ChatMessage`, `ChatTranscript`, `ChatComposer`, `CompactGroup`, `ConversationCheckpoint`, `Marker`, `Shimmer` |
| Prompt and attachments     | The `PromptInput` family with `usePromptInputAttachments`, and the `Attachment` compound                           |
| Reasoning and tools        | `Reasoning`, `ChainOfThought`, `ToolCall`, `CodeBlock`, `AgentOutput`, `MessageResponse`, `parseAgentOutput`, `formatPartialJson` |
| Plans, tasks, and queues   | `Plan`, `TaskItem`, `AgentTask`, `Queue`, `ActivityTimeline`                                                        |
| Approvals and checkpoints  | `Confirmation`, `ApprovalCard`, `Checkpoint`                                                                        |
| Sources and citations      | `Sources`, `InlineCitation`, `Suggestion`, `OpenInChat`                                                             |
| Agents and context         | `AgentDefinition`, `AgentCard`, `ModelSelector`, `ModelBadge`, `ProviderBadge`, `ContextUsage`                       |
| Coding artifacts           | `Artifact`, `Snippet`, `PackageInfo`, `SchemaDisplay`, `StackTrace`, `TestResults`, `Commit`, `ChangeSummary`, `EnvironmentVariables`, `SecretField` |
| Sandbox previews           | `Sandbox`, `WebPreview`, `JSXPreview`                                                                               |
| Workflow canvas            | `WorkflowCanvas` with its node, edge, controls, panel, toolbar, and minimap anatomy                                 |
| Vault                      | `BacklinksPanel`, `OutlineView`, the `wikilinks` and `graphModel` helpers, and the autosave machine                 |
| Time and calendar          | `RelativeTime`, `useRelativeTime`, `formatRelativeTime`, and `Calendar` with month, week, and agenda views          |
| Adapters                   | `PierreDiffView`, `CodeFileView`, `Terminal`, `MarkdownEditor`, `ChartContainer`, `KnowledgeGraph`, each behind its own subpath |

Every export of every family, with signatures, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): the entry points, the peer requirements,
  and the one style element every host renders.
- [Quickstart](./quickstart.md): build a run panel end to end.
- Concepts: [how styling ships](./concepts/styling.md),
  [theme tokens](./concepts/theming.md),
  [component anatomy](./concepts/component-anatomy.md), and
  [the adapters boundary](./concepts/adapters.md).
- Guides: [style a host application](./guides/style-a-host-application.md),
  [use a heavy renderer](./guides/use-a-heavy-renderer.md),
  [render a run status](./guides/render-run-status.md),
  [collect a prompt with attachments](./guides/collect-a-prompt.md),
  [render agent output](./guides/render-agent-output.md), and
  [test a component](./guides/test-a-component.md).
- Reference: [API](./api.md) and
  [failure codes and limits](./reference/contracts.md).
- [Troubleshooting](./troubleshooting.md): symptoms, causes, and fixes.
