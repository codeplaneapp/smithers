// smithers-source: authored
// smithers-display-name: Ship Pipeline
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { VerifiableGoals, goalsSchema, writtenSchema } from "../components/VerifiableGoals";
import { ShipTickets, researchOutputSchema, planOutputSchema, shipResultSchema, manifestSchema } from "../components/ShipTickets";
import { implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

/**
 * Ship Pipeline: break a proposal into verifiable-goal tickets, then ship every
 * ticket onto the base branch — one workflow, composed from two components:
 *   1. <VerifiableGoals> writes the ticket queue from the proposal.
 *   2. <ShipTickets> discovers that queue and lands each ticket (research →
 *      plan → implement → validate → review in a worktree, then commit + merge).
 * ShipTickets re-discovers the queue each frame, so its pipeline self-populates
 * the moment VerifiableGoals finishes writing the tickets.
 */
const inputSchema = z.object({
  prompt: z.string().default("Break the work into independently verifiable goals."),
  source: z.string().default(".smithers/proposals/real-time-collaboration.md"),
  ticketsDir: z.string().default(".smithers/tickets/ship-pipeline"),
  baseBranch: z.string().default("main"),
  tdd: z.boolean().default(false),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  // VerifiableGoals
  goals: goalsSchema,
  written: writtenSchema,
  // ShipTickets (+ its ValidationLoop / Review sub-components)
  research: researchOutputSchema,
  plan: planOutputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  shipResult: shipResultSchema,
  manifest: manifestSchema,
});

export default smithers((ctx) => (
  <Workflow name="ship-pipeline">
    <Sequence>
      <VerifiableGoals
        ctx={ctx}
        source={ctx.input.source}
        prompt={ctx.input.prompt}
        ticketsDir={ctx.input.ticketsDir}
        agents={agents.smartTool}
      />
      <ShipTickets
        ctx={ctx}
        ticketsDir={ctx.input.ticketsDir}
        baseBranch={ctx.input.baseBranch}
        tdd={ctx.input.tdd}
        agents={agents}
      />
    </Sequence>
  </Workflow>
));
