/** @jsxImportSource smithers-orchestrator */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContinueAsNew, Loop, Parallel, Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Closeout } from "./Closeout";
import { mechanical, opus, planner, sol, terra } from "./ferricAgents";
import type { FerricConfig } from "./ferricConfig";
import { SCRIPTS, assertNotInfra, sh, sha256 } from "./ferricShell";
import M0PlanPrompt from "../../prompts/ferric-m0-plan.mdx";
import M0CanaryPrompt from "../../prompts/ferric-m0-canary.mdx";
import M0OracleBuildPrompt from "../../prompts/ferric-m0-oracle-build.mdx";
import M0BridgeDocsPrompt from "../../prompts/ferric-m0-bridge-docs.mdx";
import M0DocReviewPrompt from "../../prompts/ferric-m0-doc-review.mdx";
import M0PocPrompt from "../../prompts/ferric-m0-poc.mdx";

const CANARIES = ["wasm-in-jsdom", "per-reset-cost", "cross-realm-module-cache", "rss-trend"];
const DOCS = ["BRIDGE.md", "ABI.md", "PORTING.md", "HANDLES.tsv"];

/**
 * M0 — build the judge before building anything judged.
 *
 * No Rust is ported here. The milestone ends at the boundary-POC approval gate,
 * which is where a launched campaign stops on its first run.
 */
export function PhaseM0({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const oracle = ctx.latest(outputs.frcOracle, "m0:oracle-verify");
  const oracleRounds = ctx.iterationCount(outputs.frcOracle, "m0:oracle-verify");
  const docsOk = DOCS.every((d) =>
    ctx.outputs.frcDocReview.some(
      (r: any) => r.doc === d && (r.approved === true || r.approved === 1),
    ),
  );
  const docRounds = ctx.iterationCount(outputs.frcDocReview, "m0:docreview-BRIDGE.md");
  const poc = ctx.latest(outputs.frcPoc, "m0:poc");
  const pocRounds = ctx.iterationCount(outputs.frcPoc, "m0:poc");

  const green = oracle?.ok === true && docsOk && poc != null;
  const blocked = !green && (oracleRounds >= 3 || docRounds >= 3 || pocRounds >= 2);

  return (
    <Sequence label="M0 — oracle + guides + POC">
      <Task id="m0:plan" output={outputs.frcPlan} agent={planner} timeoutMs={3_600_000}>
        <M0PlanPrompt repo={c.repo} reactRepo={c.reactRepo} scripts={SCRIPTS.join(", ")} />
      </Task>

      <Parallel label="M0 canaries" maxConcurrency={2}>
        {CANARIES.map((cn) => (
          <Task
            key={cn}
            id={`m0:canary-${cn}`}
            output={outputs.frcCanary}
            agent={mechanical}
            continueOnFail
            timeoutMs={3_600_000}
          >
            <M0CanaryPrompt canary={cn} repo={c.repo} />
          </Task>
        ))}
      </Parallel>

      <Loop id="m0:oracle-loop" until={oracle?.ok === true} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task
            id="m0:oracle-build"
            output={outputs.frcSlice}
            agent={[terra, sol]}
            timeoutMs={10_800_000}
          >
            <M0OracleBuildPrompt
              repo={c.repo}
              reactRepo={c.reactRepo}
              scripts={SCRIPTS.join(", ")}
              priorFailure={
                oracle && !oracle.ok
                  ? "## Previous attempt failed verification\n\nThe runner did not pass on unmodified React. Fix that before anything else."
                  : ""
              }
            />
          </Task>
          <Task id="m0:oracle-verify" output={outputs.frcOracle} retries={2}>
            {async () => {
              const missing = SCRIPTS.filter((s) => !existsSync(join(c.repo, s)));
              if (missing.length) {
                return {
                  passingCount: 0,
                  totalCount: 0,
                  manifestSha256: "0".repeat(64),
                  ok: false,
                };
              }
              const r = await sh(["bash", "scripts/ferric/oracle.sh", "--unmodified"], c.repo);
              assertNotInfra(r, "oracle-unmodified");
              const m = /PASSING=(\d+)\/(\d+)/.exec(r.out);
              const manifest = join(c.repo, "baseline-manifest.json");
              const body = existsSync(manifest) ? readFileSync(manifest, "utf8") : "";
              const passing = m ? Number(m[1]) : 0;
              const total = m ? Number(m[2]) : 0;
              return {
                passingCount: passing,
                totalCount: total,
                manifestSha256: body ? sha256(body) : "0".repeat(64),
                ok: r.ok && !!m && passing === total && total > 0 && body.length > 0,
              };
            }}
          </Task>
        </Sequence>
      </Loop>

      <Loop id="m0:docs-loop" until={docsOk} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task id="m0:bridge-docs" output={outputs.frcSlice} agent={sol} timeoutMs={7_200_000}>
            <M0BridgeDocsPrompt
              repo={c.repo}
              priorFindings={
                docRounds > 0
                  ? "## Address the blocking review findings\n\nRead the frcDocReview rows from the previous round and fix every blocking finding before re-reporting."
                  : ""
              }
            />
          </Task>
          <Parallel label="doc adversarial review">
            {DOCS.map((doc) => (
              <Task
                key={doc}
                id={`m0:docreview-${doc}`}
                output={outputs.frcDocReview}
                agent={opus}
                continueOnFail
                timeoutMs={1_800_000}
              >
                <M0DocReviewPrompt doc={doc} repo={c.repo} />
              </Task>
            ))}
          </Parallel>
        </Sequence>
      </Loop>

      <Task id="m0:bench-contract" output={outputs.frcBenchContract}>
        {() => {
          const path = join(c.repo, "BENCH_CONTRACT.md");
          if (!existsSync(path)) {
            writeFileSync(
              path,
              [
                "# Ferric preregistered benchmark contract (frozen at M0)",
                "- client: >=30 runs, warm geomean <=1.05x, no primary workload >1.10x",
                "- SSR: floor 0.95x, target 1.3x",
                "- leak: 10k-cycle + 10k-SSR-request probes, flat slopes",
                "- size: decoded wasm <=7.5MiB hard gate; brotli route set <=1.75x; cold p95 <=1.10x",
                "- blinded ABBA order; two reproductions >=24h apart",
              ].join("\n"),
            );
          }
          return { contractSha256: sha256(readFileSync(path, "utf8")), frozen: true };
        }}
      </Task>

      <Loop id="m0:poc-loop" until={poc?.withinKillGate === true} maxIterations={2} onMaxReached="return-last">
        <Task id="m0:poc" output={outputs.frcPoc} agent={[terra, sol]} timeoutMs={10_800_000}>
          <M0PocPrompt repo={c.repo} reactRepo={c.reactRepo} revision={pocRounds + 1} />
        </Task>
      </Loop>

      {green ? (
        <Sequence>
          <CampaignGate
            id="gate-m0-exit"
            summary={`Oracle: ${oracle.passingCount}/${oracle.totalCount} on unmodified React (manifest ${String(oracle.manifestSha256).slice(0, 12)}…). POC ratio ${(poc.ratioX1000 / 1000).toFixed(2)}x after ${poc.protocolRevisions} revision(s); ABI: ${poc.abiChoice}; withinKillGate=${poc.withinKillGate}. Bridge docs adversarially approved; bench contract frozen; canaries in frcCanary rows. M0 measurements replace every spec estimate marked "measured at M0".`}
          />
          {gateRow(ctx, "gate-m0-exit")?.approved ? (
            <ContinueAsNew
              state={{ milestone: "M1", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
            />
          ) : gateRow(ctx, "gate-m0-exit")?.approved === false ? (
            <Closeout ctx={ctx} c={c} reason="M0 exit gate denied: the operator declined to proceed past the boundary-POC decision." />
          ) : null}
        </Sequence>
      ) : blocked ? (
        <CampaignGate
          id="gate-m0-blocked"
          summary={`M0 is red after its fix loops: oracle ok=${String(oracle?.ok)} (${oracleRounds} rounds), docs approved=${docsOk} (${docRounds} rounds), POC withinKillGate=${String(poc?.withinKillGate)} (${pocRounds} revisions). Evidence: frcOracle, frcDocReview, frcPoc rows. Deny to kill (signed closeout); approve to grant another fix round via a fresh run.`}
        />
      ) : null}

      {gateRow(ctx, "gate-m0-blocked")?.approved === false ? (
        <Closeout
          ctx={ctx}
          c={c}
          reason="M0 blocked: the oracle, bridge contracts, or boundary POC stayed red after their fix loops, and the human declined to continue."
        />
      ) : null}
    </Sequence>
  );
}
