// smithers-source: authored
// smithers-display-name: Verifiable Goals
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const ticketSchema = z.object({
  slug: z.string(),
  title: z.string(),
  goal: z.string(),
  spec: z.string(),
  e2eVerification: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
});

const goalsSchema = z.looseObject({
  summary: z.string(),
  tickets: z.array(ticketSchema).default([]),
});

const writtenSchema = z.object({
  dir: z.string(),
  files: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Break the work into independently verifiable goals."),
  source: z.string().default(".smithers/proposals/real-time-collaboration.md"),
  ticketsDir: z.string().default(".smithers/tickets/ultragrill"),
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  goals: goalsSchema,
  written: writtenSchema,
});

const goalsPrompt = (source: string, prompt: string) =>
  `You are decomposing a project into independently shippable, **verifiable goals** — one per ticket.

${prompt}

## Source
Read the proposal/spec at: \`${source}\`
Explore the codebase as needed to ground each goal in real files, components, and primitives. Verify assertions before writing — do not invent file paths.

## What to produce
A list of tickets. Each ticket is ONE verifiable goal — small enough to research → plan → implement in a single focused pass, large enough to be meaningful. Order them so dependencies come first (reference earlier slugs in \`dependsOn\`).

For each ticket:
- **slug**: short kebab-case id, unique and stable (e.g. "transcription-gateway-capability").
- **title**: one line.
- **goal**: the user-visible or system capability delivered, stated as an outcome.
- **spec**: concrete implementation notes — which packages/files/primitives are involved, grounded in what you actually found.
- **e2eVerification**: EXACTLY how we prove the goal is met via an **end-to-end test that drives a real backend** (no mocks, no route fabrication — repo policy). State the user-flow the test exercises, the seeded/real state it runs against, and the observable assertion that must pass. This is the ticket's definition of done.
- **acceptanceCriteria**: a checklist of specific, checkable conditions.
- **dependsOn**: slugs that must land first, or [].

Prefer more small verifiable goals over a few big ones. Be exhaustive about coverage; keep each ticket tight.`;

export default smithers((ctx) => (
  <Workflow name="verifiable-goals">
    <Sequence>
      <Task id="goals" output={goalsSchema} agent={agents.smartTool}>
        {goalsPrompt(ctx.input.source, ctx.input.prompt)}
      </Task>

      <Task id="write" output={writtenSchema}>
        {async () => {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const current = ctx.outputMaybe("goals", { nodeId: "goals" });
          if (!current) throw new Error("goals task produced no output");
          const dir = path.resolve(process.cwd(), ctx.input.ticketsDir);
          fs.mkdirSync(dir, { recursive: true });
          const files: string[] = [];
          current.tickets.forEach((t: any, i: number) => {
            const index = String(i + 1).padStart(4, "0");
            const file = path.join(dir, `${index}-${t.slug}.md`);
            const body = [
              `---`,
              `slug: ${t.slug}`,
              `title: ${JSON.stringify(t.title)}`,
              `dependsOn: [${(t.dependsOn ?? []).join(", ")}]`,
              `---`,
              ``,
              `# ${t.title}`,
              ``,
              `## Goal`,
              t.goal,
              ``,
              `## Spec`,
              t.spec,
              ``,
              `## E2E Verification (definition of done)`,
              t.e2eVerification,
              ``,
              `## Acceptance Criteria`,
              ...(t.acceptanceCriteria ?? []).map((c: string) => `- [ ] ${c}`),
              ``,
            ].join("\n");
            fs.writeFileSync(file, body, "utf8");
            files.push(path.relative(process.cwd(), file));
          });
          return { dir: ctx.input.ticketsDir, files };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
