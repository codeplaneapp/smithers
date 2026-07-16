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
export {
  normalizeStatus,
  statusClass,
  formatStatus,
  isTerminalRunStatus,
  type StatusClass,
} from "./status";
export {
  SmithersUiStyles,
  composeSmithersUiStyles,
  smithersUiCss,
  SMITHERS_UI_STYLE_ATTR,
  type SmithersUiStylesProps,
} from "./styles";

export { Button, buttonVariants, type ButtonProps } from "./button";
export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { StatusPill, type StatusPillProps } from "./status-pill";
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
