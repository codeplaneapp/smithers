import { useChatStore } from "../chat/chatStore";
import { useRunsListStore } from "../runs/runsListStore";
import { startWorkflowRun } from "../gateway/startWorkflowRun";
import { openSurface } from "./navigation";

/** Launch a run on the gateway: the `implement` workflow with a prompt. */
export function launchRun(prompt?: string): Promise<string | undefined> {
  return startWorkflowRun({
    workflowKey: "implement",
    inputs: { prompt: prompt ?? "" },
  });
}

/** Launch a named workflow with a prompt. */
export function composeThenLaunchRun(workflowKey: string, prompt: string): Promise<string | undefined> {
  return startWorkflowRun({ workflowKey, inputs: { prompt } });
}

/**
 * Route a feature slash command to a canvas surface or a gateway action. Returns
 * false for anything it does not own. Local-only: the cloud-only slashes (vcs,
 * terminal, issues, landings, onboarding) are gone; everything else opens
 * the matching gateway-backed surface.
 */
export function runSlash(name: string, arg: string): boolean {
  const runs = useRunsListStore.getState().runs;
  const latest = runs[0];
  const chat = useChatStore.getState();
  switch (name) {
    case "run":
    case "implement":
      void composeThenLaunchRun("implement", arg);
      return true;
    case "concierge":
      void composeThenLaunchRun("concierge", arg);
      return true;
    case "logs":
      if (latest) {
        openSurface({
          kind: "gatewayRun",
          workflowKey: latest.workflowKey || latest.runId,
          runId: latest.runId,
          view: "logs",
        });
      } else {
        chat.say("No run selected. Start a workflow first.");
      }
      return true;
    case "timeline":
    case "fork":
      if (latest) {
        openSurface({
          kind: "gatewayRun",
          workflowKey: latest.workflowKey || latest.runId,
          runId: latest.runId,
          view: "timeline",
        });
      } else {
        chat.say("No run selected yet.");
      }
      return true;
    case "runs":
      openSurface({ kind: "runs" });
      return true;
    case "approvals":
    case "gates":
    case "decisions":
      openSurface({ kind: "approvals" });
      return true;
    case "agents":
      openSurface({ kind: "agents" });
      return true;
    case "memory":
      openSurface({ kind: "memory" });
      return true;
    case "files":
      openSurface({ kind: "files" });
      return true;
    case "eval":
    case "scores":
      openSurface({ kind: "scores" });
      return true;
    case "cron":
    case "crons":
      openSurface({ kind: "crons" });
      return true;
    case "prompt":
    case "prompts":
    case "prompteditor":
      openSurface({ kind: "prompts" });
      return true;
    case "ticket":
    case "tickets":
      openSurface({ kind: "tickets" });
      return true;
    case "workflow":
    case "wf":
      openSurface({ kind: "runs" });
      return true;
    case "palette":
    case "find":
    case "open":
      openSurface({ kind: "palette" });
      return true;
    default:
      return false;
  }
}
