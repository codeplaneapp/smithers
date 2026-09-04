---
title: "API reference"
description: "Every public export of @smthrs/ui and its ten subpaths: the styling and theming core, the status vocabulary, every component family, the pure helpers, and the six heavy adapters."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/docs/api.md"
---

The `exports` map in `package.json` is the public API. It carries no wildcard,
so anything reachable only through a relative path carries no promise. Every
symbol below is exported from the specifier named in its section heading.

Component props types follow the shape `ComponentProps<"element"> & { ... }`,
so every component also accepts the host attributes and handlers of the element
it renders. Where a component renders a control the host does not own directly,
it takes an explicit props bag instead.

## Entry points

| Specifier                              | Contents                                                      | Heavy dependency |
| -------------------------------------- | ------------------------------------------------------------- | ---------------- |
| `@smthrs/ui`                           | Everything on this page except the adapter sections           | None             |
| `@smthrs/ui/status`                    | [The status vocabulary](#the-status-vocabulary)               | None             |
| `@smthrs/ui/time`                      | [Time](#time)                                                 | None             |
| `@smthrs/ui/calendar`                  | [Calendar](#calendar)                                         | None             |
| `@smthrs/ui/vault`                     | [Vault](#vault)                                               | None             |
| `@smthrs/ui/adapters/chart`            | [Chart](#chart)                                               | `recharts`       |
| `@smthrs/ui/adapters/terminal`         | [Terminal](#terminal)                                         | `@xterm/*`       |
| `@smthrs/ui/adapters/code-view`        | [Code view](#code-view)                                       | `@pierre/diffs`  |
| `@smthrs/ui/adapters/pierre-diff-view` | [Pierre diff view](#pierre-diff-view)                         | `@pierre/diffs`  |
| `@smthrs/ui/adapters/markdown-editor`  | [Markdown editor](#markdown-editor)                           | `@milkdown/*`    |
| `@smthrs/ui/adapters/knowledge-graph`  | [Knowledge graph](#knowledge-graph)                           | `d3-force`       |

The four non-adapter subpaths are slices of the root barrel, offered for import
ergonomics. Everything they export is also on `@smthrs/ui`.

## Styling

```ts
function SmithersUiStyles(props?: SmithersUiStylesProps): JSX.Element
function composeSmithersUiStyles(props?: SmithersUiStylesProps): string
function prefersReducedMotion(): boolean
function observeReducedMotion(listener: (reduced: boolean) => void): () => void
function cn(...inputs: ClassValue[]): string

const smithersUiCss: string
const standaloneThemeCss: string
const SMITHERS_UI_STYLE_ATTR: "data-smithers-ui"
const REDUCED_MOTION_MEDIA_QUERY: "(prefers-reduced-motion: reduce)"

type SmithersUiStylesProps = { withTheme?: boolean; extra?: string }
```

| Export                     | Meaning                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SmithersUiStyles`         | Renders the composed sheet in a `<style>` element. Render exactly once per document. Safe under `renderToStaticMarkup`.           |
| `composeSmithersUiStyles`  | The string behind that element. `withTheme` prepends the styleguide token block; `extra` is appended last, so its rules win.      |
| `smithersUiCss`            | The component sheet alone, with no theme block and no extras.                                                                     |
| `standaloneThemeCss`       | Re-exported from [`@smthrs/ui-styleguide`](https://ui-styleguide.smithers.sh/reference/api/).                                                                   |
| `SMITHERS_UI_STYLE_ATTR`   | The marker attribute on rendered and injected style elements. The self-injection fallback stands down when it finds one.          |
| `prefersReducedMotion`     | The current motion preference. Answers `false` with no `window`.                                                                  |
| `observeReducedMotion`     | Subscribes to preference changes. Returns an unsubscribe function; a no-op with no `window`.                                      |
| `cn`                       | `clsx` class composition. No `tailwind-merge`, because every class is `sui-` namespaced.                                          |

`useInjectUiCss` is deliberately not exported from the barrel: components call
it internally, and it is not a consumer styling API.

## Theming

```ts
const tokens: SmithersUiTokens
const themeRegistry: DeepReadonly<Record<ResolvedPalette, SmithersTheme>>
const DEFAULT_THEME_KEY: "night-owl"

function resolveTheme(root?: ThemeRoot | null, media?: ThemeMedia | null): ResolvedTheme
function subscribeTheme(onChange: () => void): () => void
function resolvePalette(root?: PaletteRoot | null): ResolvedPalette
function subscribePalette(onChange: () => void): () => void
function useResolvedPalette(): ResolvedPalette

type ResolvedTheme = "light" | "dark"
type ResolvedPalette = keyof typeof themeRegistry
type SmithersUiTokens = typeof tokens
```

| Export               | Meaning                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens`             | The semantic token table. Every value is a `var(--house-token, #lightFallback)` expression, not a color.                                 |
| `resolveTheme`       | An explicit `data-theme` on `<html>` wins; otherwise the OS `prefers-color-scheme` decides. Resolves `"light"` outside a browser.        |
| `subscribeTheme`     | Fires on a `data-theme` mutation and on an OS preference change. Returns an unsubscribe function.                                        |
| `resolvePalette`     | Reads `data-palette` on `<html>`, accepting only registered keys and falling back to `DEFAULT_THEME_KEY`.                                |
| `subscribePalette`   | Fires on a `data-palette` mutation. Returns an unsubscribe function.                                                                     |
| `useResolvedPalette` | The hook form of `resolvePalette`, re-rendering on change.                                                                               |
| `themeRegistry`      | The eight palettes, re-exported from [`@smthrs/ui-styleguide`](https://ui-styleguide.smithers.sh/reference/api/).                                                      |

Both `resolveTheme` and `resolvePalette` take optional injectable roots, which
is how the package tests them without a document.

## The status vocabulary

Also available from `@smthrs/ui/status`, which pulls in no React.

```ts
function normalizeStatus(status: string | undefined): string
function statusClass(status: string | undefined): StatusClass
function statusColor(status: string | undefined): string
function hasStatusTone(status: string | undefined): boolean
function formatStatus(status: string | undefined): string
function isTerminalRunStatus(status: string | undefined): boolean

const statusColors: Readonly<Record<string, string>> & Readonly<Record<StatusClass, string>>

type StatusClass = "ok" | "warn" | "bad" | "muted" | "run"
```

| Export                | Meaning                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeStatus`     | Trims, lowercases, and maps `_` to `-`. `undefined` becomes `""`.                                                                                 |
| `statusClass`         | The tone bucket. Any `waiting-*` status is `"warn"`; an unknown status is `"muted"`.                                                              |
| `hasStatusTone`       | Whether the vocabulary knows this status, which distinguishes a deliberately neutral status from an unrecognized one.                             |
| `statusColor`         | The token expression the matching tone paints with.                                                                                              |
| `statusColors`        | Both keyings of the same table: by tone, and by every known normalized status.                                                                    |
| `formatStatus`        | The human label. Falls through to a title-cased rendering of the spelling; `undefined` becomes `"Unknown"`.                                       |
| `isTerminalRunStatus` | Whether the run finished, failed, or was cancelled. Narrower than "not running": a parked run is neither.                                         |

Every lookup table is a frozen null-prototype container, so a status string
sourced from a host cannot resolve through `Object.prototype`.

## Base components

| Export                                                                                     | Props type                     | Notes                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `Button`, `buttonVariants`                                                                 | `ButtonProps`                  | Variants `default` (house tinted brand), `solid`, `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `sm`, `default`, `lg`, `icon`. `asChild`, `loading`. Defaults `type="button"`. |
| `Badge`, `badgeVariants`                                                                   | `BadgeProps`                   | `asChild`.                                                                                    |
| `StatusPill`                                                                               | `StatusPillProps`              | `status`, `label`, `withDot`.                                                                 |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | Element props               | The panel family.                                                                             |
| `Input`, `Textarea`                                                                        | Element props                  | Themed form controls.                                                                         |
| `Label`, `Field`                                                                           | Element props                  | `Field` pairs a label with its control.                                                       |
| `Alert`, `AlertTitle`, `AlertDescription`, `alertVariants`                                  | `AlertProps`                   | Tone through the CVA recipe.                                                                  |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`   | Element props                  | Themed table anatomy.                                                                         |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`                                            | `TabsTriggerProps`             | Radix Tabs.                                                                                   |
| `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` | `DialogContentProps` | Radix Dialog. Portal content is styled because every rule is document-global. |
| `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent`                            | Element props                  | Radix Tooltip.                                                                                |
| `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator` | Element props | Radix Select.                                                       |
| `Progress`                                                                                  | `ProgressProps`                | Radix Progress.                                                                               |
| `Separator`, `Skeleton`                                                                     | Element props                  | Hairline rule and loading placeholder.                                                        |
| `Spinner`, `spinnerVariants`                                                                | `SpinnerProps`                 | Sizes through the CVA recipe.                                                                 |
| `EmptyState`                                                                                | `EmptyStateProps`              | `icon`, `title`, `description`, `action`.                                                     |
| `SectionHeader`, `Eyebrow`                                                                  | `SectionHeaderProps`           | `title`, `eyebrow`, `actions`.                                                                |
| `RowButton`                                                                                 | `RowButtonProps`               | `active` applies the house selected-row recipe.                                               |
| `KpiStat`                                                                                   | `KpiStatProps`                 | `label`, `value`, `hint`.                                                                     |
| `StageStrip`, `stageTone`                                                                   | `StageStripProps`, `StageStripItem`, `StageTone` | `stages`, `showSummary`, `summaryLabel`.                                    |
| `CollapsiblePanel`                                                                          | `CollapsiblePanelProps`        | `title`, `status`, `statusLabel`, `meta`, controlled or uncontrolled `open`.                  |
| `Markdown`                                                                                  | `MarkdownProps`, `MarkdownLinkClick` | Dependency-free renderer. Builds React children rather than `innerHTML`, and scheme-filters link hrefs. |
| `FileTree`                                                                                  | `FileTreeProps`, `FileTreeItem`, `FileTreeNode`, `FileTreeNodeProps`, `FileTreeDirectoryProps` | Flat `/`-delimited paths grouped into a nested tree, with controlled single selection. |
| `useDialogFocusTrap`                                                                        | `UseDialogFocusTrapOptions`    | `{ active, containerRef, initialFocusRef, onClose }`. Focus containment for a custom overlay. |

## Diffs

```ts
function parseUnifiedFile(diffText: string, overrides?: ParseUnifiedFileOverrides): DiffFile
function parseHunks(diffText: string): { lines: DiffLine[]; add: number; del: number; partial: boolean }
function groupHunks(file: DiffFile): Hunk[]
function paginateHunks(file: DiffFile, visibleCount: number): { hunks: Hunk[]; hidden: number }
function diffTotals(diff: Diff): { files: number; add: number; del: number }
function totalBytes(diff: Diff): number
function fileLineCount(file: DiffFile): number
function fileStatus(file: DiffFile): DiffFileStatus
function statusLetter(file: DiffFile): string
function detectBinary(file: DiffFile): boolean
function binaryBodyLabel(file: DiffFile): string
function byteCountString(bytes: number): string
function isLargeDiff(diff: Diff): boolean
function initialExpanded(diff: Diff): string[]

const LARGE_FILE_COUNT: 50
const LARGE_BYTE_LIMIT: 1000000
const PAGINATE_THRESHOLD: 2000
const PAGINATE_VISIBLE: 1000

type Diff, DiffFile, DiffFileStatus, DiffLine, DiffLineKind, Hunk, ParseUnifiedFileOverrides
```

`DiffHunks` (`DiffHunksProps`) is the renderer over that model, with no
third-party dependency. `byteCountString` answers `"unknown size"` for a
negative or non-finite count rather than rendering `NaN`. The four constants are
the pagination policy documented in
[Failure codes and limits](/reference/contracts/).

## Time

Also available from `@smthrs/ui/time`.

```ts
function formatRelativeTime(ts: number, now?: number): string
function useRelativeTime(ts: number): string

type RelativeTimeProps // { ts: number; title?: string; relativeUntilMs?: number }
```

`RelativeTime` renders a `<time>` element that re-renders off one ref-counted
one-second interval shared by every mounted instance and hook. A timestamp
outside the range `Date` can hold still renders its label and omits `dateTime`
and `title` rather than throwing.

## Conversation

| Export                                                                                                                                                   | Types                                                                                       | Notes                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ChatMessage`                                                                                                                                            | `ChatMessageProps`, `ChatMessageRole`                                                       | One message with an optional label, meta, and pending state. |
| `ChatTranscript`                                                                                                                                         | `ChatTranscriptProps`                                                                       | The drop-in transcript surface.                    |
| `ChatComposer`                                                                                                                                           | `ChatComposerProps`, `ChatComposerStatus`                                                   | Controlled glass composer. `submitProps` and `stopProps` stamp host attributes on the two buttons. |
| `Message`, `MessageAvatar`, `MessageHeader`, `MessageContent`, `MessageFooter`, `MessageActions`, `MessageGroup`                                          | `MessageProps`, `MessageRole`, `MessageAvatarProps`, `MessageActionsProps`                  | The compound message anatomy.                      |
| `MessageBranch`, `MessageBranchContent`, `MessageBranchSelector`, `MessageBranchPrevious`, `MessageBranchNext`, `MessageBranchPage`                       | `MessageBranchProps`                                                                        | Alternate responses with a pager.                  |
| `MessageScrollerProvider`, `MessageScrollerViewport`, `MessageScrollerContent`, `MessageScrollerItem`, `MessageScrollerButton`                            | `MessageScrollerProviderProps`, `MessageScrollerViewportProps`, `MessageScrollerContentProps`, `MessageScrollerItemProps`, `MessageScrollerButtonProps` | Stick-to-bottom scrolling anatomy. |
| `useMessageScroller`, `useMessageVisibility`, `useMessageScrollerState`                                                                                  | `MessageScrollerCommands`                                                                   | Imperative commands, per-message visibility, and viewport state. |
| `Bubble`, `BubbleContent`, `BubbleActions`, `BubbleReactions`, `bubbleVariants`                                                                          | `BubbleProps`, `BubbleReaction`, `BubbleReactionsProps`                                     | The bubble surface family.                         |
| `Attachment`, `AttachmentMedia`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, `AttachmentActions`, `AttachmentAction`, `AttachmentTrigger`, `AttachmentGroup`, `AttachmentPreview`, `AttachmentRemove` | `AttachmentProps`, `AttachmentState`, `AttachmentActionProps`, `AttachmentPreviewProps` | Attachment chips and previews. |
| `CompactGroup`, `ConversationCheckpoint`                                                                                                                 | `CompactGroupProps`, `ConversationCheckpointProps`                                          | Collapsed history and a conversation marker.       |
| `Marker`, `Shimmer`                                                                                                                                      | `MarkerProps`, `ShimmerProps`                                                               | Inline divider and the text shimmer.               |

## Prompt input

| Export                                                                                                                                                                                                              | Types                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PromptInput`, `PromptInputHeader`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputButton`, `PromptInputSubmit`, `PromptInputStop`, `PromptInputActionMenu`, `PromptInputActionMenuTrigger`, `PromptInputActionMenuContent`, `PromptInputActionAddAttachments` | `PromptInputProps`, `PromptInputTextareaProps`, `PromptInputActionMenuProps`, `PromptInputStatus` |
| `usePromptInputAttachments`                                                                                                                                                                                          | Returns `{ attachments, add, remove, clear, openFileDialog }`                                                |
|                                                                                                                                                                                                                      | `PromptInputMessage`, `PromptInputAttachmentItem`, `PromptInputError`                                       |

`onSubmit` receives `(message: PromptInputMessage, event)`. Returning a promise
holds the draft and its blob URLs until it settles. Every refusal reports a
`PromptInputError` through `onError`; the codes and the object-URL ownership
rule are in [Failure codes and limits](/reference/contracts/).

## Reasoning and tools

```ts
function parseAgentOutput(value: unknown): AgentOutputModel | null
function formatJsonSafe(value: unknown): string
function formatPartialJson(text: string): { text: string; complete: boolean }
function toolCallStatus(state: ToolCallState): "running" | "pending" | "waiting-approval" | "complete" | "error" | "denied"
function chainOfThoughtStepStatus(status: ChainOfThoughtStepStatus | undefined): "pending" | "running" | "complete"

const TOOL_CALL_STATE_LABELS: Readonly<Record<ToolCallState, string>>
```

| Export                                                                                                            | Types                                                                                                                       | Notes                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Reasoning`, `ReasoningTrigger`, `ReasoningContent`, `ReasoningSummary`                                            | `ReasoningProps`, `ReasoningTriggerProps`, `ReasoningContentProps`, `ReasoningSummaryProps`                                  | Provider-disclosed summaries only. The parts throw outside `<Reasoning composed>`. |
| `ChainOfThought`, `ChainOfThoughtStep`                                                                             | `ChainOfThoughtProps`, `ChainOfThoughtStepProps`, `ChainOfThoughtStepStatus`                                                | Ordered thought steps.                                                             |
| `ToolCall`, `ToolCallHeader`, `ToolCallContent`, `ToolCallInput`, `ToolCallOutput`, `ToolCallError`, `ToolCallApproval` | `ToolCallProps`, `ToolCallState`, `ToolResultPart`, and one props type per part                                        | Eight lifecycle states from `input-streaming` to `output-denied`.                  |
| `CodeBlock`, `CodeBlockHeader`, `CodeBlockFilename`, `CodeBlockGroup`, `CodeBlockTabs`                              | `CodeBlockProps`, `CodeBlockHighlighter`, `HighlightLine`, `HighlightedToken`, `CodeBlockGroupItem`, and one props type per part | Copy, wrapping, line numbers, and a `highlight` seam that needs no adapter.     |
| `MessageResponse`                                                                                                  | `MessageResponseProps`                                                                                                      | Streaming markdown over the `Markdown` primitive.                                  |
| `AgentOutput`                                                                                                      | `AgentOutputProps`, `AgentOutputModel`, `AgentOutputToolCall`                                                               | Renders a parsed model: response, reasoning summary, and tool calls.               |

`CodeBlockHighlighter` is
`(code: string, language: string | undefined) => readonly HighlightLine[] | null`.

## Plans, tasks, and queues

| Export                                                                                                            | Types                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Plan`, `PlanHeader`, `PlanTitle`, `PlanDescription`, `PlanTrigger`, `PlanContent`, `PlanStep`, `PlanAction`, `PlanFooter`, `planStepStatus` | `PlanProps`, `PlanStepProps`, `PlanStepStatus`                |
| `TaskItem`, `TaskItemFile`                                                                                        | `TaskItemProps`, `TaskItemFileProps`                                             |
| `AgentTask`, `AgentTaskTrigger`, `AgentTaskContent`, `AgentTaskGroup`                                             | `AgentTaskProps`, `AgentTaskContentProps`                                        |
| `Queue`, `QueueSection`, `QueueSectionTrigger`, `QueueSectionLabel`, `QueueSectionContent`, `QueueList`, `QueueItem`, `QueueItemIndicator`, `QueueItemContent`, `QueueItemDescription` | `QueueSectionProps`, `QueueSectionLabelProps`, `QueueItemProps`, `QueueItemIndicatorProps` |
| `ActivityTimeline`, `ActivityItem`, `ActivityGroup`                                                               | `ActivityTimelineProps`, `ActivityItemProps`, `ActivityGroupProps`, `ActivityKind`, `ActivityItemModel` |

`planStepStatus` maps a plan step onto
`"pending" | "running" | "complete" | "failed" | "skipped"`.

## Approvals and checkpoints

```ts
function approvalStateToStatus(state: ApprovalState): string
function approvalStateLabel(state: ApprovalState): string
function useCheckpoint(): CheckpointContextValue

const CHECKPOINT_ACTION_KINDS: readonly CheckpointActionKind[]
```

| Export                                                                                                                          | Types                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Confirmation`, `ConfirmationTitle`, `ConfirmationRequest`, `ConfirmationAccepted`, `ConfirmationRejected`, `ConfirmationActions`, `ConfirmationAction` | `ConfirmationProps`, `ConfirmationActionProps`, `ApprovalState`                       |
| `ApprovalCard`, `ApprovalRisk`, `ApprovalResources`, `ApprovalNote`                                                             | `ApprovalCardProps`, `ApprovalRiskProps`, `ApprovalResourcesProps`, `ApprovalNoteProps`, `ApprovalRiskLevel`, `ApprovalResource` |
| `Checkpoint`, `CheckpointIcon`, `CheckpointMetadata`, `CheckpointTrigger`, `CheckpointActions`                                  | `CheckpointProps`, `CheckpointModel`, `CheckpointActionKind`, `CheckpointTriggerProps`, `CheckpointActionsProps` |

`approvalStateToStatus` returns a string from the shared status vocabulary, so
an approval and a run agree on tone.

## Sources and citations

| Export                                                              | Types                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Sources`, `SourcesTrigger`, `SourcesContent`, `Source`             | `SourcesProps`, `SourceItem`, `SourcesTriggerProps`, `SourcesContentProps`, `SourceProps`         |
| `InlineCitation`, `CitationCard`, `CitationCarousel`, `CitationQuote` | `InlineCitationProps`, `CitationSource`, `CitationCardProps`, `CitationCarouselProps`, `CitationQuoteProps` |
| `Suggestion`, `SuggestionGroup`                                     | `SuggestionProps`, `SuggestionGroupProps`                                                         |
| `OpenInChat`                                                        | `OpenInChatProps`, `OpenInChatSubject`, `OpenInChatSubjectKind`                                   |

## Agents and context

```ts
function availabilityLabel(availability: AgentAvailability): string
function contextUsagePercent(usage: TokenUsageModel): number | undefined
```

| Export                                                                                                                                 | Types                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AgentDefinition`, `AgentHeader`, `AgentContent`, `AgentInstructions`, `AgentTools`, `AgentTool`, `AgentOutputSchema`, `AgentAvailabilityBadge` | `AgentDefinitionProps`, `AgentAvailability`, `AgentToolDescriptorModel`, `AgentAvailabilityBadgeProps`, `AgentInstructionsProps`, `AgentToolProps`, `AgentOutputSchemaProps` |
| `AgentCard`                                                                                                                            | `AgentCardProps`                                                                                                         |
| `ModelSelector`, `ModelSelectorTrigger`, `ModelSelectorContent`, `ModelSelectorGroup`, `ModelSelectorItem`                              | `ModelSelectorProps`, `ModelOption`, `ModelSelectorItemProps`                                                            |
| `ModelBadge`, `ProviderBadge`                                                                                                          | `ModelBadgeProps`, `ProviderBadgeProps`                                                                                  |
| `ContextUsage`, `ContextTrigger`, `ContextContent`, `ContextContentHeader`, `ContextContentBody`, `ContextContentFooter`, `ContextInputUsage`, `ContextOutputUsage`, `ContextReasoningUsage`, `ContextCacheUsage` | `ContextUsageProps`, `TokenUsageModel`                        |

`contextUsagePercent` answers `undefined` when `usedTokens` or `maxTokens` is
absent, or when `maxTokens` is not positive, rather than guessing at a
denominator. Otherwise it rounds and clamps to 100.

## Coding artifacts

```ts
function parseStackTrace(text: string): StackFrameData[]
function testCaseStatusToStatus(status: TestCaseStatus): string
function formatTestDuration(durationMs: number): string
function useCommitModel(): CommitModel | null
```

| Export                                                                                                                                                                       | Types                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Artifact`, `ArtifactHeader`, `ArtifactTitle`, `ArtifactDescription`, `ArtifactActions`, `ArtifactAction`, `ArtifactClose`, `ArtifactContent`                                 | `ArtifactActionProps`, `ArtifactCloseProps`                                                      |
| `Snippet`                                                                                                                                                                    | `SnippetProps`                                                                                   |
| `PackageInfo`                                                                                                                                                                | `PackageInfoProps`                                                                               |
| `SchemaDisplay`                                                                                                                                                              | `SchemaDisplayProps`                                                                             |
| `StackTrace`, `StackFrame`                                                                                                                                                   | `StackTraceProps`, `StackFrameProps`, `StackFrameData`                                           |
| `TestResults`, `TestResultsHeader`, `TestResultsSummary`, `TestResultsDuration`, `TestResultsProgress`, `TestResultsContent`, `TestSuite`, `TestSuiteName`, `TestSuiteStats`, `TestSuiteContent`, `TestRow`, `TestStatus`, `TestName` | `TestResultsProps`, `TestResultsDurationProps`, `TestSuiteProps`, `TestRowProps`, `TestStatusProps`, `TestCaseStatus`, `TestCaseModel`, `TestSuiteModel` |
| `Commit`, `CommitHeader`, `CommitAuthor`, `CommitInfo`, `CommitMessage`, `CommitMetadata`, `CommitHash`, `CommitTimestamp`, `CommitActions`, `CommitFiles`, `CommitFile`, `CommitFileStatus`, `CommitFilePath` | `CommitProps`, `CommitModel`, `CommitFileModel`, `CommitFileStatusKind`, and one props type per part |
| `ChangeSummary`                                                                                                                                                              | `ChangeSummaryProps`                                                                             |
| `EnvironmentVariables`, `EnvironmentVariable`                                                                                                                                | `EnvironmentVariablesProps`, `EnvironmentVariableProps`, `EnvironmentVariableModel`              |
| `SecretField`                                                                                                                                                                | `SecretFieldProps`                                                                               |

`SchemaDisplay` and `SecretField` enforce bounds documented in
[Failure codes and limits](/reference/contracts/).

## Sandbox previews

```ts
function sandboxStateToStatus(state: SandboxState): string
```

| Export                                                                        | Types                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Sandbox`, `SandboxHeader`, `SandboxStatus`, `SandboxActions`, `SandboxContent` | `SandboxProps`, `SandboxStatusProps`, `SandboxActionsProps`, `SandboxState`                                  |
| `WebPreview`, `WebPreviewToolbar`, `WebPreviewAddress`, `WebPreviewContent`     | `WebPreviewProps`, `WebPreviewToolbarProps`, `WebPreviewAddressProps`, `WebPreviewContentProps`, `WebPreviewSandboxToken` |
| `JSXPreview`                                                                   | `JSXPreviewProps`                                                                                            |

`WebPreviewContent` takes `sandboxAllow`, a list of `WebPreviewSandboxToken`
values, defaulting to `["allow-scripts", "allow-forms"]`. It renders the iframe
`sandbox` attribute from that list under three rules it enforces itself:

- Each entry is trimmed, lowercased, and accepted only when the whole entry is
  one of the five known keywords. An unknown or packed entry is rejected
  wholesale with a console warning rather than salvaged into a capability.
- `allow-same-origin` is dropped whenever `allow-scripts` is also present. The
  pair would let the framed page remove its own sandbox.
- `src` must be an absolute `http` or `https` URL or a root-relative
  same-origin path. Anything else, including `javascript:`, `data:`, `blob:`,
  protocol-relative, and backslash network-path forms, is refused, and the
  sanitized string is what gets rendered.

## Workflow canvas

| Export                                                                                                                                                                | Types                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowCanvas`, `WorkflowNode`, `WorkflowNodeHeader`, `WorkflowNodeContent`, `WorkflowNodeStatus`, `WorkflowEdge`, `WorkflowConnection`, `WorkflowControls`, `WorkflowPanel`, `WorkflowToolbar`, `WorkflowMinimap` | `WorkflowCanvasProps`, `WorkflowNodeProps`, `WorkflowNodeStatusProps`, `WorkflowEdgeProps`, `WorkflowConnectionProps`, `WorkflowControlsProps`, `WorkflowPanelProps` |

## Calendar

Also available from `@smthrs/ui/calendar`.

```ts
function monthGridDays(anchorMs: number, weekStartsOn?: number): number[]
function weekDays(anchorMs: number, weekStartsOn?: number): number[]
function eventsOnDay(events: CalendarEvent[], dayMs: number): CalendarEvent[]
function agendaGroups(events: CalendarEvent[]): AgendaDayGroup[]
function startOfDay(ms: number): number
function addDays(ms: number, days: number): number
function addMonths(ms: number, months: number): number
function daysInMonth(year: number, month: number): number
function isSameDay(a: number, b: number): boolean
function minutesIntoDay(ms: number): number
function snapUp30(minutes: number): number
function snapDown30(minutes: number): number
function dayKey(ms: number): string
function monthLabel(ms: number): string
function weekLabel(days: number[]): string
function weekdayLabel(ms: number): string
function fullDayLabel(ms: number): string
function timeLabel(ms: number): string
function hashSource(source: string | undefined): number

const DAY_MS: 86400000
const HOUR_MS: 3600000
const MINUTE_MS: 60000
const CALENDAR_CSS_ID: "calendar"
const calendarCss: string
```

`Calendar` (`CalendarProps`) renders month, week, and agenda views over
`CalendarEvent` values, with `CalendarView` naming the three. Every timestamp is
Unix epoch milliseconds. `hashSource` is the per-source tint rotation, which is
what gives an event without an explicit `color` a stable one.

## Vault

Also available from `@smthrs/ui/vault`.

```ts
function parseWikilinks(markdown: string): Wikilink[]
function wikilinksToMarkdown(body: string, resolve: (target: string) => string): string
function restoreWikilinks(markdown: string): string
function noteHref(path: string): string
function pathFromHref(href: string): string
function noteLabel(path: string): string
function splitFrontmatter(source: string): { frontmatter: string | null; body: string }
function joinFrontmatter(frontmatter: string | null, body: string): string

function computeGraphModel(notes: readonly VaultNoteMeta[], links: readonly VaultLink[]): { nodes: VaultGraphNode[]; links: VaultGraphEdge[] }
function neighbourSet(hover: string | null, links: readonly VaultGraphEdge[]): Set<string> | null
function nodeRadius(degree: number): number
function shouldShowLabel(degree: number, threshold?: number): boolean
function noteFolder(path: string): string
function folderTint(folder: string): GraphFolderTint
function folderTintIndex(folder: string): number
function folderHue(folder: string): number

function parseOutline(markdown: string): OutlineHeading[]
function createAutosaveDoc(options: AutosaveDocOptions): AutosaveDoc
function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult
function autosaveStatusText(state: AutosaveState): string
function useVaultCss(): void

const NOTE_HREF: "#note/"
const GRAPH_FOLDER_TINTS: readonly ["brand", "success", "info", "warning"]
const HUB_LABEL_MIN_DEGREE: 6
const AUTOSAVE_STATUS_TEXT: Record<AutosaveState, string>
const VAULT_CSS_ID: "vault"
const vaultCss: string
```

`BacklinksPanel` (`BacklinksPanelProps`) and `OutlineView` (`OutlineViewProps`,
`OutlineHeading`) are the two panels. `VaultAdapter`, `VaultNoteMeta`, and
`VaultLink` are the host contract: `tree`, `read`, and `write` are required, and
`links` and `graph` are optional bulk reads.

`AutosaveState` is `"clean" | "dirty" | "saving" | "saved" | "conflict"`, and
`AutosaveSnapshot.failure` carries an `AutosaveFailure` whose
`AutosaveFailureCode` is `"read-failed"` or `"write-failed"`. Reporting
`mtimeMs` from `save` advances the conflict baseline; a writer that cannot
report one is safe, just more conservative about declaring conflicts.

`KnowledgeGraph` is not here. It ships from
[`@smthrs/ui/adapters/knowledge-graph`](#knowledge-graph).

## Chart

`@smthrs/ui/adapters/chart`. Pulls in `recharts`.

```ts
function chartConfig(series: ReadonlyArray<{ key: string; label?: ReactNode }>): ChartConfig
function chartSeriesColor(index: number, theme?: "light" | "dark"): string

const CHART_SERIES: ReadonlyArray<{ readonly light: string; readonly dark: string }>
```

`ChartProvider`, `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`,
`ChartLegend`, and `ChartLegendContent` are the shadcn chart contract over
Recharts. `ChartConfig` maps a series key to a label, an icon, and either a
color or a light and dark pair.

`CHART_SERIES` is eight validated slots in fixed order. `chartSeriesColor`
clamps an index past the palette to the last slot rather than cycling: fold
extra series into an "Other" bucket or facet the chart.

## Terminal

`@smthrs/ui/adapters/terminal`. Pulls in `@xterm/xterm` and `@xterm/addon-fit`.

```ts
function terminalThemeFor(palette: ResolvedPalette, mode: TerminalColorTheme): ITheme

type TerminalWriter = (data: string | Uint8Array) => void
type TerminalStream = (write: TerminalWriter) => void | (() => void)
type TerminalColorTheme = "dark" | "light"
type TerminalInstance = XTerminal
```

`Terminal` (`TerminalProps`) owns the emulator, the fit addon, theming, and
resize. `lines` writes a snapshot once; `stream` subscribes to live output and
may return a teardown; `onData` carries keystrokes out; `onResize` fires after
every fit; `onReady` hands back the raw xterm.js instance. `theme`, `palette`,
and `colors` override the theme resolved from the document. `readOnly`,
`scrollback`, `fontSize`, `fontFamily`, and `cursorBlink` configure the
emulator.

The xterm base stylesheet is vendored as a string and injected through the same
seam as the rest of the library, so a host must not import
`@xterm/xterm/css/xterm.css`.

## Code view

`@smthrs/ui/adapters/code-view`. Pulls in `@pierre/diffs` and Shiki.

```ts
function languageForFile(name: string): string | null

const CODE_VIEW_REST_MS: 300
const CODE_VIEW_POOL_DEADLINE_MS: 15000
const currentCodeViewPool: () => CodeViewPool
const subscribeCodeViewPool: (listener: () => void) => () => void
```

`CodeFileView` (`CodeFileViewProps`) renders one file: `name` supplies the
grammar, `contents` the text, `line` a 1-based anchor that is marked and
scrolled into view, and `mode` and `palette` override the document's theme.
`annotations` (`CodeLineAnnotation`) render under their lines, and the consumer
must memoize the array because a new one redraws the rows. `onTokenRest` fires
once per token after the pointer rests for `CODE_VIEW_REST_MS`, reporting a
`CodeTokenPosition`.

`languageForFile` answers `null` when no grammar claims the name, which is the
signal to keep your own plain text. Until the highlighter paints, the component
renders a plain `<pre>`.

## Pierre diff view

`@smthrs/ui/adapters/pierre-diff-view`. Pulls in `@pierre/diffs` and Shiki.

```ts
function patchToCodeViewItems(patch: string, selectedPath?: string | null): CodeViewItem[]
function diffsThemeForMode(mode: PierreDiffMode, palette?: ResolvedPalette): DiffsThemeNames
function diffStyleForLayout(layout: PierreDiffLayout): "split" | "unified"
function normalizeDiffPath(path: string | undefined): string

type PierreDiffMode = "light" | "dark"
type PierreDiffLayout = "split" | "inline"
```

`PierreDiffView` (`PierreDiffViewProps`) renders a unified patch: `layout`
chooses side by side against unified, `selectedPath` narrows a multi-file patch
to one file, and `emptyLabel` covers an empty or unparseable patch.

`normalizeDiffPath` decodes git's quoted, octal-escaped path form and strips a
leading `a/` or `b/`, which is why `selectedPath` compares equal across all four
spellings of a name.

Syntax token colors stay the bundled Shiki `github-light` and `github-dark`
pair. The underlying `CodeView` accepts a theme name but exposes no custom
theme-registration prop, so replacing those tokens would require owning a
separate highlighter and worker registration path.

## Markdown editor

`@smthrs/ui/adapters/markdown-editor`. Pulls in `@milkdown/*`.

```ts
function supportsRichTextEditing(): boolean

const markdownEditorCss: string
const MARKDOWN_EDITOR_STYLE_ATTR: string

type MarkdownEditorErrorCode = "editor-load-failed" | "editor-create-failed"
```

`MarkdownEditor` (`MarkdownEditorProps`) takes `value` as the initial document,
not a controlled value, and reports edits through `onChange`. `resetKey` forces
a re-seed when the host switches documents. `loadEditor`
(`MarkdownEditorModule`) is the injectable module loader, which is how a test or
a host with its own build drives the rich path. `escapeTabOrder` defaults to
true so Tab moves focus out rather than trapping a keyboard user. `fallback`
forces the textarea or the rich editor, overriding the
`supportsRichTextEditing` probe. `MarkdownEditorHandle` exposes `getMarkdown`
and the imperative seams.

`MarkdownEditorStyles` ships the Crepe theme through the library's style seam.
`MarkdownEditorError` carries a `code` and the original `cause`; both codes are
described in [Failure codes and limits](/reference/contracts/).

## Knowledge graph

`@smthrs/ui/adapters/knowledge-graph`. Pulls in `d3-force`.

`KnowledgeGraph` (`KnowledgeGraphProps`) renders the vault graph over a force
simulation. The graph math it draws is not behind this subpath:
`computeGraphModel`, `nodeRadius`, `folderTint`, and `neighbourSet` are on the
base barrel, so a host can compute a graph without loading the renderer.

## Related

- [Failure codes and limits](/reference/contracts/): the codes and bounds
  referenced throughout this page.
- [The adapters boundary](/concepts/adapters/): what the six adapter
  subpaths cost.
- [Troubleshooting](/troubleshooting/): symptoms and fixes.
