/** @jsxImportSource smithers-orchestrator */
/**
 * Operation Ferric — the single durable Smithers workflow.
 *
 * Rewrites React's runtime in Rust (WASM in the browser, native for SSR), judged
 * by React's own unmodified test suite. Spec: .smithers/specs/react-rust-port.md
 * (v3) plus the round-3 gate-DAG spec text.
 *
 * This file is the GRAPH. It holds no prompts and no component bodies:
 *   - prompts live in .smithers/prompts/ferric-*.mdx
 *   - components live in .smithers/components/ferric/*.tsx
 * The single-script contract (spec §6) is about one workflow — one launchable
 * graph, no Subflow and no second workflow — not about one physical file.
 *
 * Launch contract (M0 only, detached, FROM THE CAMPAIGN REPO ROOT):
 *   cd <campaignRepo> && smithers up .smithers/workflows/react-rust-port.tsx -d
 * The foundation gate hard-fails if the launch root is not the campaign repo:
 * worktree lanes fork the launch root while landings merge into the campaign
 * repo, so they must be the same repository.
 */
import { Aspects, ContinueAsNew, Sequence, TryCatchFinally, UI } from "smithers-orchestrator";
import { Workflow, Task, smithers, outputs } from "../components/ferric/ferricSmithers";
import { FoundationAndBudget } from "../components/ferric/FoundationAndBudget";
import { PhaseM0 } from "../components/ferric/PhaseM0";
import { PhaseM25 } from "../components/ferric/PhaseM25";
import { PhaseM3 } from "../components/ferric/PhaseM3";
import { PhaseM4 } from "../components/ferric/PhaseM4";
import { PhaseM5M6 } from "../components/ferric/PhaseM5M6";
import { PhaseM7 } from "../components/ferric/PhaseM7";
import { PhaseM8 } from "../components/ferric/PhaseM8";
import { PhaseGA } from "../components/ferric/PhaseGA";
import { PhaseM9 } from "../components/ferric/PhaseM9";
import { TrialPhase } from "../components/ferric/TrialPhase";
import { SuiteTask } from "../components/ferric/SuiteTask";
import { Sidecar } from "smithers-orchestrator";
import { schemaAdherenceScorer, latencyScorer } from "smithers-orchestrator/scorers";
import { luna, terra } from "../components/ferric/ferricAgents";
import { MILESTONE_TOKEN_BUDGET, cfg, type SliceDef } from "../components/ferric/ferricConfig";
import M1FlagCodegenPrompt from "../prompts/ferric-m1-flag-codegen.mdx";

const M1_SLICES: SliceDef[] = [
  { id: "m1-react-is", kind: "phase", modules: ["react-is"], gate: "react-is jest suite, 100%" },
  { id: "m1-shared", kind: "phase", modules: ["shared"], gate: "shared jest suite, 100%" },
];
const M2_SLICES: SliceDef[] = [
  {
    id: "m2-scheduler",
    kind: "phase",
    modules: ["scheduler"],
    gate: "Scheduler suite 100% incl. unstable_mock exports",
  },
  {
    id: "m2-noop-skeleton",
    kind: "phase",
    modules: ["react-noop-renderer skeleton"],
    gate: "noop host mounts/schedules/commits through Ferric",
  },
];

export default smithers((ctx) => {
  const c = cfg(ctx);
  const m = c.milestone;

  const phase =
    m === "M0" ? (
      <PhaseM0 ctx={ctx} c={c} />
    ) : m === "M1" ? (
      <TrialPhase
        ctx={ctx}
        c={c}
        milestone="M1"
        slices={M1_SLICES}
        gateId="gate-m1-exit"
        summary="The trial exists to prove the machine — implement, two adversarial reviews, deterministic verify, land, ratchet — on 4.2k lines before it carries the reconciler."
        extra={
          <Sidecar
            id="m1:flag-codegen"
            agent={terra}
            sidecar={luna}
            output={outputs.frcSlice}
            sidecarOutput={outputs.frcSidecarShadow}
            scorers={{
              schema: { scorer: schemaAdherenceScorer() },
              latency: { scorer: latencyScorer({ targetMs: 1_800_000, maxMs: 3_600_000 }) },
            }}
          >
            <M1FlagCodegenPrompt repo={c.repo} reactRepo={c.reactRepo} />
          </Sidecar>
        }
      />
    ) : m === "M2" ? (
      <TrialPhase
        ctx={ctx}
        c={c}
        milestone="M2"
        slices={M2_SLICES}
        gateId="gate-m2-exit"
        summary="M2 does not close on the scheduler suite alone: the WHOLE remaining React suite must stay green while running on the Rust scheduler through the swappable JavaScript seam (D2)."
        evidence={
          <SuiteTask
            id="m2:seam-suite"
            leg="whole suite on Rust unstable_mock through the require('scheduler') seam"
            args={["--leg", "scheduler-seam"]}
            repo={c.repo}
          />
        }
      />
    ) : m === "M25" ? (
      <PhaseM25 ctx={ctx} c={c} />
    ) : m === "M3" ? (
      <PhaseM3 ctx={ctx} c={c} />
    ) : m === "M4" ? (
      <PhaseM4 ctx={ctx} c={c} />
    ) : m === "M5M6" ? (
      <PhaseM5M6 ctx={ctx} c={c} />
    ) : m === "M7" ? (
      <PhaseM7 ctx={ctx} c={c} />
    ) : m === "M8" ? (
      <PhaseM8 ctx={ctx} c={c} />
    ) : m === "GA" ? (
      <PhaseGA ctx={ctx} c={c} />
    ) : m === "M9" ? (
      <PhaseM9 ctx={ctx} c={c} />
    ) : (
      <Task id="campaign-complete" output={outputs.frcCloseout}>
        {{
          milestone: "DONE",
          summaryMarkdown: `Operation Ferric complete. Lineage: ${[...c.lineage, "final"].join(" → ")}. Every gate was human-decided; the ratchet stayed monotone end to end; publishes were idempotency-keyed and last in the graph.`,
          killed: false,
        }}
      </Task>
    );

  return (
    <Workflow name="react-rust-port">
      <UI entry="../ui/react-rust-port.tsx" />
      <Sequence>
        <FoundationAndBudget ctx={ctx} c={c} />
        <TryCatchFinally
          id={`ferric-${m}`}
          try={<Aspects tokenBudget={{ max: MILESTONE_TOKEN_BUDGET, onExceeded: "fail" }}>{phase}</Aspects>}
          // Scoped to exactly ONE code: token-budget exhaustion rolls this
          // milestone into a fresh run (a durable /clear — the engine carries
          // completed output rows across, so nothing re-runs). Every other
          // failure, including a deliberate gate denial, stops loudly. An
          // earlier draft caught everything here and turned denials into an
          // infinite, self-funding loop.
          catchErrors={["ASPECT_BUDGET_EXCEEDED"]}
          catch={
            <ContinueAsNew state={{ milestone: m, spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }} />
          }
        />
      </Sequence>
    </Workflow>
  );
});
