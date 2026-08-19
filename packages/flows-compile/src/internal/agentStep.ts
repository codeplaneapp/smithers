import * as Digest from "@flows/core/Digest";
import { AgentStep, TextDeclaration } from "@flows/harness/AgentStep";
import type { AgentLike, TaskDescriptor } from "@smthrs/graph/types";
import * as Option from "effect/Option";
import { jsonSafe } from "./jsonSafe.ts";

const text = (value: string): TextDeclaration => new TextDeclaration({ text: value, digest: Digest.digest(value) });

const agents = (task: TaskDescriptor): readonly AgentLike[] =>
  task.agent === undefined ? [] : Array.isArray(task.agent) ? task.agent : [task.agent];

/**
 * The `harness:model` seat for a task's agent.
 *
 * A Smithers agent names itself with a flat `id` (`claude-code`, `codex`); a
 * harness seat is `harness:model`. An id that already carries a colon is
 * already a seat and is kept; anything else names the harness and takes the
 * harness's own default model, because Smithers resolves the model inside the
 * agent rather than declaring it on the task.
 */
export const seatOf = (task: TaskDescriptor): string => {
  const first = agents(task)[0];
  const id = first?.id ?? first?.capabilities?.engine ?? "smithers";
  return id.includes(":") ? id : `${id}:default`;
};

/** Tool names the agent exposes, sorted so the declaration is order-free. */
const toolNames = (task: TaskDescriptor): readonly string[] => {
  const names = new Set<string>();
  for (const agent of agents(task)) {
    for (const name of Object.keys(agent.tools ?? {})) names.add(name);
    for (const name of Object.keys(agent.capabilities?.runtimeTools ?? {})) names.add(name);
  }
  return [...names].sort();
};

/**
 * The instruction sections a task contributes beyond its prompt.
 *
 * Smithers keeps these on the descriptor rather than in the prompt string, so
 * they are declared separately here too and stay individually addressable in
 * the transcript the harness builds.
 */
const instructions = (task: TaskDescriptor): readonly TextDeclaration[] => {
  const out: TextDeclaration[] = [];
  if (task.label !== undefined) out.push(text(`label: ${task.label}`));
  if (task.outputTableName !== "") out.push(text(`output: ${task.outputTableName}`));
  return out;
};

/**
 * The serializable half of one agent run.
 *
 * Everything the harness needs that a plan can hold: the seat, the declared
 * text, the tool surface, and the resolved inputs. Runtime providers, tool
 * implementations, and the host layer are deliberately absent — they are
 * supplied where the step executes, not where it is planned.
 */
export const agentStepFor = (task: TaskDescriptor, input: Record<string, unknown>): AgentStep =>
  new AgentStep({
    seat: seatOf(task),
    thinkingLevel: "medium",
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    input: jsonSafe(input),
    system: text(task.label ?? task.nodeId),
    instructions: instructions(task),
    prompt: text(task.prompt ?? ""),
    journal: [],
    activeToolNames: toolNames(task),
    toolDefinitions: [],
    contextWindowTokens: 0,
  });
