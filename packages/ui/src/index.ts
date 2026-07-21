/**
 * @smithers-orchestrator/ui
 *
 * Shared component library for Smithers UIs: shadcn component anatomy (slots,
 * CVA variant APIs, asChild, data-slot attributes) and Radix behavior, styled
 * entirely through the ui-styleguide theme tokens so every component is
 * correct in light AND dark (OS `prefers-color-scheme`, with an explicit
 * `data-theme` override that always wins).
 *
 * Styling ships as a CSS-in-TS string (`smithersUiCss`) because the gateway
 * UI bundler drops `.css` imports: render `<SmithersUiStyles/>` once at the
 * root, and components also self-inject the sheet in the browser as a
 * fallback. All classes are namespaced `sui-*` so nothing collides with the
 * styleguide page vocabulary or consumer CSS.
 *
 * @example
 * ```tsx
 * import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
 * import { Button, Card, CardHeader, CardTitle, SmithersUiStyles, StatusPill } from "smithers-orchestrator/ui";
 *
 * function App() {
 *   return (
 *     <main>
 *       <SmithersUiStyles />
 *       <Card>
 *         <CardHeader>
 *           <CardTitle>Runs</CardTitle>
 *           <StatusPill status="running" />
 *         </CardHeader>
 *         <Button onClick={() => {}}>Launch</Button>
 *       </Card>
 *     </main>
 *   );
 * }
 * createGatewayReactRoot(<App />);
 * ```
 */

export { cn } from "./cn";
export { tokens, type SmithersUiTokens } from "./tokens";
export { resolveTheme, subscribeTheme, type ResolvedTheme } from "./internal/resolveTheme";
export {
  normalizeStatus,
  statusClass,
  statusColor,
  statusColors,
  formatStatus,
  isTerminalRunStatus,
  type StatusClass,
} from "./status";
export {
  SmithersUiStyles,
  composeSmithersUiStyles,
  smithersUiCss,
  standaloneThemeCss,
  SMITHERS_UI_STYLE_ATTR,
  REDUCED_MOTION_MEDIA_QUERY,
  prefersReducedMotion,
  observeReducedMotion,
  type SmithersUiStylesProps,
} from "./styles";

export { Button, buttonVariants, type ButtonProps } from "./button";
export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { StatusPill, type StatusPillProps } from "./status-pill";
export { Reasoning, type ReasoningProps } from "./agentic/Reasoning";
export {
  ChainOfThought,
  chainOfThoughtStepStatus,
  type ChainOfThoughtProps,
  type ChainOfThoughtStep,
  type ChainOfThoughtStepStatus,
} from "./agentic/ChainOfThought";
export {
  ToolCall,
  toolCallStatus,
  TOOL_CALL_STATE_LABELS,
  type ToolCallProps,
  type ToolCallState,
} from "./agentic/ToolCall";
export { formatJsonSafe } from "./agentic/formatJsonSafe";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "./card";
export { Input, Textarea } from "./input";
export { Label, Field } from "./label";
export {
  ChatMessage,
  type ChatMessageProps,
  type ChatMessageRole,
} from "./chat/ChatMessage";
export { ChatTranscript, type ChatTranscriptProps } from "./chat/ChatTranscript";
export { ChatComposer, type ChatComposerProps } from "./chat/ChatComposer";
export { MessageScroller, type MessageScrollerProps, type MessageScrollerHandle } from "./chat/MessageScroller";
export { Bubble, bubbleVariants, type BubbleProps } from "./chat/Bubble";
export { Attachment, type AttachmentProps, type AttachmentState } from "./chat/Attachment";
export { Marker, type MarkerProps } from "./chat/Marker";
export { Shimmer, type ShimmerProps } from "./chat/Shimmer";
export { Alert, AlertTitle, AlertDescription, alertVariants, type AlertProps } from "./alert";
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./table";
export { Tabs, TabsList, TabsTrigger, TabsContent, type TabsTriggerProps } from "./tabs";
export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  type DialogContentProps,
} from "./dialog";
export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "./tooltip";
export { Plan, planStepStatus, type PlanProps, type PlanStep, type PlanStepStatus } from "./agentic/Plan";
export { TaskItem, type TaskItemProps } from "./agentic/TaskItem";
export { Sources, type SourcesProps, type SourceItem } from "./agentic/Sources";
export { InlineCitation, type InlineCitationProps } from "./agentic/InlineCitation";
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "./select";
export { Progress, type ProgressProps } from "./progress";
export { Separator } from "./separator";
export { Skeleton } from "./skeleton";
export { Spinner, spinnerVariants, type SpinnerProps } from "./spinner";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { SectionHeader, Eyebrow, type SectionHeaderProps } from "./section-header";
export { RowButton, type RowButtonProps } from "./row-button";
export { KpiStat, type KpiStatProps } from "./kpi-stat";
export {
  StageStrip,
  stageTone,
  type StageStripProps,
  type StageStripItem,
  type StageTone,
} from "./stage-strip";
export { CollapsiblePanel, type CollapsiblePanelProps } from "./collapsible-panel";
export { DiffHunks, type DiffHunksProps } from "./diff-hunks";
export type { Diff, DiffFile, DiffFileStatus, DiffLine, DiffLineKind, Hunk } from "./diff";
export {
  binaryBodyLabel,
  byteCountString,
  detectBinary,
  diffTotals,
  fileLineCount,
  fileStatus,
  groupHunks,
  initialExpanded,
  isLargeDiff,
  paginateHunks,
  parseHunks,
  parseUnifiedFile,
  statusLetter,
  totalBytes,
  LARGE_BYTE_LIMIT,
  LARGE_FILE_COUNT,
  PAGINATE_THRESHOLD,
  PAGINATE_VISIBLE,
  type ParseUnifiedFileOverrides,
} from "./diff-paginate";
export {
  FileTree,
  type FileTreeProps,
  type FileTreeNode,
  type FileTreeItem,
} from "./file-tree";
export { Markdown, safeMarkdownHref, type MarkdownProps, type MarkdownLinkClick } from "./primitives/markdown";
export { MessageResponse, type MessageResponseProps } from "./agentic/MessageResponse";
export {
  AgentOutput,
  type AgentOutputProps,
  type AgentOutputModel,
  type AgentOutputToolCall,
} from "./agentic/AgentOutput";
export { parseAgentOutput } from "./agentic/parseAgentOutput";
export {
  CodeBlock,
  type CodeBlockProps,
  type CodeBlockHighlighter,
  type HighlightLine,
  type HighlightedToken,
} from "./agentic/CodeBlock";

// lane:workflow-canvas exports (integration: keep)
export {
  WorkflowCanvas,
  WorkflowNode,
  WorkflowNodeHeader,
  WorkflowNodeContent,
  WorkflowNodeStatus,
  WorkflowEdge,
  WorkflowConnection,
  WorkflowControls,
  WorkflowPanel,
  WorkflowToolbar,
  WorkflowMinimap,
  type WorkflowCanvasProps,
  type WorkflowNodeProps,
  type WorkflowNodeStatusProps,
  type WorkflowEdgeProps,
  type WorkflowConnectionProps,
  type WorkflowControlsProps,
  type WorkflowPanelProps,
} from "./canvas/WorkflowCanvas";
