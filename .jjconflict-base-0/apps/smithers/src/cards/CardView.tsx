import { AgentsCard } from "../agents/AgentsCard";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { CronsCard } from "../crons/CronsCard";
import { DiffCard } from "../diff/DiffCard";
import { LogsCard } from "../logs/LogsCard";
import { HumanCard } from "../human/HumanCard";
import { SignalCard } from "../human/SignalCard";
import { LaunchCard } from "../launch/LaunchCard";
import { MemoryCard } from "../memory/MemoryCard";
import { PromptsCard } from "../prompts/PromptsCard";
import { PromptsEditorCard } from "../prompts/PromptsEditorCard";
import { RunCard } from "../runs/RunCard";
import { RunsCard } from "../runs/RunsCard";
import { ApprovalsCard } from "../approvals/ApprovalsCard";
import { PaletteCard } from "../palette/PaletteCard";
import { WorkflowEditorCard } from "../store/WorkflowEditorCard";
import { ScoresCard } from "../scores/ScoresCard";
import { TicketsCard } from "../tickets/TicketsCard";
import { GatewayRunCard } from "../gateway/GatewayRunCard";
import type { Card } from "./Card";
// Styles for every feature card and canvas surface. Imported here (a statically
// loaded module) so they inject globally without editing the shared styles.css.
import "./featureCards.css";

/** Render the component for an inline card. The one place card.kind is fanned out. */
export function CardView({ card }: { card: Card }) {
  switch (card.kind) {
    case "run":
      return <RunCard runId={card.runId} />;
    case "gatewayRun":
      return <GatewayRunCard workflowKey={card.workflowKey} runId={card.runId} />;
    case "approval":
      return <ApprovalCard runId={card.runId} />;
    case "diff":
      return <DiffCard runId={card.runId} />;
    case "logs":
      return <LogsCard runId={card.runId} />;
    case "launch":
      return <LaunchCard workflowId={card.workflowId} />;
    case "agents":
      return <AgentsCard />;
    case "memory":
      return <MemoryCard query={card.query} />;
    case "scores":
      return <ScoresCard />;
    case "crons":
      return <CronsCard />;
    case "human":
      return <HumanCard />;
    case "signal":
      return <SignalCard event={card.event} />;
    case "prompts":
      return <PromptsCard />;
    case "tickets":
      return <TicketsCard />;
    case "runsList":
      return <RunsCard />;
    case "approvalsList":
      return <ApprovalsCard />;
    case "promptsEditor":
      return <PromptsEditorCard />;
    case "workflowEditor":
      return <WorkflowEditorCard />;
    case "palette":
      return <PaletteCard />;
    default:
      return null;
  }
}
