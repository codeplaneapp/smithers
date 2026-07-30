/** @jsxImportSource smithers-orchestrator */
import { Loop, MergeQueue, Parallel, Sequence, Worktree } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { codexReviewerSeatsFor, implementerSeatsFor, opusSeatsFor } from "./ferricAgents";
import { LANE_ROOT, type FerricConfig, type SliceDef } from "./ferricConfig";
import { readLedger, writeLedger } from "./ferricLedger";
import { assertNotInfra, sh } from "./ferricShell";
import SliceImplementPrompt from "../../prompts/ferric-slice-implement.mdx";
import SliceReviewPrompt from "../../prompts/ferric-slice-review.mdx";

const CLAUDE_LENS =
  "Your lens: semantic drift from the TypeScript original, missed DEV-warning parity, and " +
  "anything that recurses on tree depth. Compare against the upstream sources directly.";
const CODEX_LENS =
  "Your lens: ABI and S1–S26 contract violations, reentrancy hazards from E1–E12, ownership " +
  "and generational-handle misuse, and tests that were narrowed rather than satisfied.";

/**
 * One vertical slice: implement in an isolated lane, loop implement → two
 * diff-only adversarial reviews from different model families → deterministic
 * in-lane verifier, until ONE convergence predicate holds.
 *
 * That predicate also gates land admission, which is what makes the verifier's
 * veto structural: no reviewer and no human approval can route around it.
 */
export function Slice(props: { key?: string; ctx: any; c: FerricConfig; slice: SliceDef }) {
  const { ctx, c, slice } = props;
  const sid = slice.id;
  const ledger = readLedger(c.repo);
  if (ledger.landed.includes(sid)) return null;

  const verify = ctx.latest(outputs.frcVerify, `${sid}:verify`);
  const revClaude = ctx.latest(outputs.frcReview, `${sid}:review-claude`);
  const revCodex = ctx.latest(outputs.frcReview, `${sid}:review-codex`);
  const rounds = ctx.iterationCount(outputs.frcVerify, `${sid}:verify`);

  // Escalation raises the Codex tier for the implementer seat and flips the
  // Codex reviewer to the opposite tier, so the model that wrote a slice can
  // never be the model that reviews it.
  // Per-lane seats: lanes run concurrently, so each takes a different slot in
  // the account-fleet rotation instead of every lane stacking on the same
  // "best" account and collapsing its session window.
  const escalated = rounds >= 2;
  const implementAgent = implementerSeatsFor(sid, escalated);
  const codexReviewer = codexReviewerSeatsFor(sid, escalated);
  const claudeReviewer = opusSeatsFor(sid);

  const converged = verify?.ok === true && revClaude?.approved === true && revCodex?.approved === true;

  const lanePath = `${LANE_ROOT}/${sid}`;
  const diffCommand = `jj diff --from "fork_point(main | ferric/${sid})" --to ferric/${sid}`;
  const feedback = [
    verify && !verify.ok ? `Deterministic verifier VETO (fix these first):\n${verify.reasons}` : "",
    revClaude && !revClaude.approved ? `Reviewer (claude-opus) blocking findings:\n${revClaude.findings}` : "",
    revCodex && !revCodex.approved ? `Reviewer (codex) blocking findings:\n${revCodex.findings}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Sequence label={`slice ${sid}`}>
      <Worktree id={`${sid}:wt`} path={lanePath} branch={`ferric/${sid}`} baseBranch="main">
        <Loop id={`${sid}:loop`} until={converged} maxIterations={4} onMaxReached="return-last">
          <Sequence>
            <Task id={`${sid}:implement`} output={outputs.frcSlice} agent={implementAgent} timeoutMs={7_200_000}>
              <SliceImplementPrompt
                sliceId={sid}
                kind={slice.kind}
                modules={slice.modules.join(", ")}
                gate={slice.gate || "the mapped jest cohort"}
                reactRepo={c.reactRepo}
                feedback={feedback ? `## Blocking feedback from the previous round\n\n${feedback}` : ""}
              />
            </Task>
            <Parallel label={`${sid} adversarial review`}>
              <Task
                id={`${sid}:review-claude`}
                output={outputs.frcReview}
                agent={claudeReviewer}
                continueOnFail
                timeoutMs={1_800_000}
              >
                <SliceReviewPrompt
                  sliceId={sid}
                  reviewer="claude-opus"
                  lens={CLAUDE_LENS}
                  diffCommand={diffCommand}
                  reactRepo={c.reactRepo}
                />
              </Task>
              <Task
                id={`${sid}:review-codex`}
                output={outputs.frcReview}
                agent={codexReviewer}
                continueOnFail
                timeoutMs={1_800_000}
              >
                <SliceReviewPrompt
                  sliceId={sid}
                  reviewer="codex"
                  lens={CODEX_LENS}
                  diffCommand={diffCommand}
                  reactRepo={c.reactRepo}
                />
              </Task>
            </Parallel>
            <Task id={`${sid}:verify`} output={outputs.frcVerify} retries={2}>
              {async () => {
                // Deterministic verifier: compute, no model, executed in the LANE
                // worktree. Every step below is exit-coded; a step that cannot run is a
                // red, never a skip (assertNotInfra still discriminates OOM/timeout).
                const lane = ctx.worktreePath(`${sid}:wt`) ?? lanePath;
                const reasons: string[] = [];
                const diffRange = `fork_point(main | ferric/${sid})`;

                const diff = await sh(["jj", "diff", "--from", diffRange, "--to", `ferric/${sid}`, "--stat"], lane);
                if (!diff.ok || diff.out.trim().length === 0) {
                  reasons.push("lane has no committed diff vs its fork point");
                }

                // The patch itself, for the review UI's DiffHunks surface.
                // Truncated so a large slice cannot bloat the persisted row.
                const patch = await sh(
                  [
                    "bash",
                    "-lc",
                    'jj diff --from "$1" --to "$2" --git | head -c 200000',
                    "bash",
                    diffRange,
                    `ferric/${sid}`,
                  ],
                  lane,
                );

                const stubs = await sh(
                  [
                    "bash",
                    "-lc",
                    'jj diff --from "$1" --to "$2" | grep -nE "todo!\\(|unimplemented!\\(" | head -20 || true',
                    "bash",
                    diffRange,
                    `ferric/${sid}`,
                  ],
                  lane,
                );
                if (stubs.out.trim()) reasons.push(`stub markers in diff:\n${stubs.out}`);

                // unsafe is permitted only inside the ABI crate (ownership mandate §1).
                const unsafeGrep = await sh(
                  [
                    "bash",
                    "-lc",
                    'jj diff --from "$1" --to "$2" -- \'glob:**/*.rs\' \'glob:!crates/ferric-abi/**\' | grep -nE "^\\+.*\\bunsafe\\b" | head -20 || true',
                    "bash",
                    diffRange,
                    `ferric/${sid}`,
                  ],
                  lane,
                );
                if (unsafeGrep.out.trim()) {
                  reasons.push(`unsafe outside crates/ferric-abi:\n${unsafeGrep.out}`);
                }

                const check = await sh(["cargo", "check", "--workspace", "--locked"], lane);
                assertNotInfra(check, "cargo-check");
                if (!check.ok) reasons.push(`cargo check failed:\n${check.err.slice(-2000)}`);

                const clippy = await sh(
                  ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
                  lane,
                );
                assertNotInfra(clippy, "cargo-clippy");
                if (!clippy.ok) reasons.push(`clippy failed:\n${clippy.err.slice(-2000)}`);

                const unit = await sh(["cargo", "test", "--workspace", "--locked"], lane);
                assertNotInfra(unit, "cargo-test");
                if (!unit.ok) reasons.push(`cargo test failed:\n${unit.err.slice(-2000)}`);

                // D3, mechanically: no engine function recurses on tree/element/child
                // depth. Engine crates only — diff-ffi test tooling is exempt by path.
                const recursion = await sh(
                  [
                    "bash",
                    "scripts/ferric/tree-recursion-lint.sh",
                    "crates/ferric-engine",
                    "crates/ferric-lane",
                    "crates/ferric-fiber",
                  ],
                  lane,
                );
                assertNotInfra(recursion, "tree-recursion-lint");
                if (!recursion.ok) {
                  reasons.push(`D3 tree-depth recursion lint:\n${recursion.err.slice(-2000)}`);
                }

                // FFI differential tier (test-only feature; slices that declare a
                // differential target must be byte-identical to the pinned JS reference).
                const hasDiffTarget = await sh(
                  [
                    "bash",
                    "-lc",
                    'jj diff --from "$1" --to "$2" --name-only | grep -q "diff-ffi" && echo yes || true',
                    "bash",
                    diffRange,
                    `ferric/${sid}`,
                  ],
                  lane,
                );
                if (hasDiffTarget.out.trim() === "yes") {
                  const ffi = await sh(
                    ["cargo", "test", "--locked", "--features", "diff-ffi", "--test", "differential"],
                    lane,
                  );
                  assertNotInfra(ffi, "diff-ffi");
                  if (!ffi.ok) reasons.push(`FFI differential tier diverged:\n${ffi.err.slice(-2000)}`);
                }

                // Per-slice DEV-warning parity (only for slices touching warnings.rs).
                const touchesWarnings = await sh(
                  [
                    "bash",
                    "-lc",
                    'jj diff --from "$1" --to "$2" --name-only | grep -q "warnings.rs" && echo yes || true',
                    "bash",
                    diffRange,
                    `ferric/${sid}`,
                  ],
                  lane,
                );
                if (touchesWarnings.out.trim() === "yes") {
                  const parity = await sh(["bash", "scripts/ferric/warnings-parity.sh", sid], lane);
                  assertNotInfra(parity, "warnings-parity");
                  if (!parity.ok) reasons.push(`warning parity check failed:\n${parity.err.slice(-2000)}`);
                }

                // The slice suite runs under the handle tripwire (FERRIC_HANDLE_TRIPWIRE=1
                // is set inside slice-suite.sh from M2 onward; the script must print
                // HANDLE_LEAKS=0 alongside PASSING=n/m).
                const suite = await sh(["bash", "scripts/ferric/slice-suite.sh", sid], lane);
                assertNotInfra(suite, "slice-suite");
                const m = /PASSING=(\d+)\/(\d+)/.exec(suite.out);
                const passed = m ? Number(m[1]) : 0;
                const total = m ? Number(m[2]) : 0;
                if (!suite.ok || !m) {
                  reasons.push(`slice suite not green/parseable:\n${(suite.out || suite.err).slice(-2000)}`);
                } else if (passed !== total || total === 0) {
                  reasons.push(`slice suite ${passed}/${total} — zero-test runs don't count`);
                }
                const leaks = /HANDLE_LEAKS=(\d+)/.exec(suite.out);
                if (!leaks) {
                  reasons.push("slice suite did not report HANDLE_LEAKS (tripwire not armed)");
                } else if (Number(leaks[1]) !== 0) {
                  reasons.push(`handle tripwire: HANDLE_LEAKS=${leaks[1]} live handles after teardown`);
                }

                return {
                  sliceId: sid,
                  ok: reasons.length === 0,
                  testsPassed: passed,
                  testsTotal: total,
                  reasons: reasons.join("\n---\n") || "clean",
                  diffText: patch.out || null,
                };
              }}
            </Task>
          </Sequence>
        </Loop>
      </Worktree>

      {converged && !ledger.halted ? (
        // Every land task in the campaign mounts under this same explicit id, so
        // the engine pools them into ONE cap-1 landing queue across all lanes.
        <MergeQueue id="ferric-land">
          <Task id={`${sid}:land:e${ledger.haltEpoch}`} output={outputs.frcLand}>
            {async () => {
              const led = readLedger(c.repo);
              if (led.landed.includes(sid)) {
                return {
                  sliceId: sid,
                  landed: true,
                  regression: false,
                  ratchetBefore: led.passingCount,
                  ratchetAfter: led.passingCount,
                  haltEpoch: led.haltEpoch,
                };
              }

              const merge = await sh(
                [
                  "bash",
                  "-lc",
                  'jj new main "$1" -m "$2" && jj bookmark set main -r @',
                  "bash",
                  `ferric/${sid}`,
                  `[ferric] land ${sid}`,
                ],
                c.repo,
              );
              if (!merge.ok) throw new Error(`land merge failed for ${sid}:\n${merge.err.slice(-2000)}`);

              // The ratchet is measured AFTER the merge, on the merged tree.
              const suite = await sh(["bash", "scripts/ferric/oracle.sh", "--ratchet"], c.repo);
              assertNotInfra(suite, "ratchet");
              const m = /PASSING=(\d+)\/(\d+)/.exec(suite.out);
              const after = m ? Number(m[1]) : 0;
              const total = m ? Number(m[2]) : 0;
              const regression = !m || after < led.passingCount;

              if (regression) {
                await sh(["bash", "-lc", "jj bookmark set main -r main- --allow-backwards"], c.repo);
                writeLedger(c.repo, { ...led, halted: true });
                return {
                  sliceId: sid,
                  landed: false,
                  regression: true,
                  ratchetBefore: led.passingCount,
                  ratchetAfter: after,
                  haltEpoch: led.haltEpoch,
                };
              }

              writeLedger(c.repo, {
                passingCount: after,
                totalCount: total,
                landed: [...led.landed, sid],
                haltEpoch: led.haltEpoch,
                halted: false,
              });
              return {
                sliceId: sid,
                landed: true,
                regression: false,
                ratchetBefore: led.passingCount,
                ratchetAfter: after,
                haltEpoch: led.haltEpoch,
              };
            }}
          </Task>
        </MergeQueue>
      ) : null}
    </Sequence>
  );
}
