/** @jsxImportSource smithers-orchestrator */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Task, outputs } from "./ferricSmithers";
import type { FerricConfig, SliceDef } from "./ferricConfig";

/**
 * The eleven cohorts the reconciler's 59-module import cycle lands as.
 *
 * This is an explicit table, not a name regex: the regex bucketing it replaces
 * let `/Transition/` steal three commit-phase ViewTransition modules into the
 * hooks cohort, hid a 15.8k-LOC cohort behind a clean-looking count check, and
 * stamped every cohort with the blanket 76-file suite. The assignment below
 * comes from a greedy feedback-arc-set linearization of the intra-SCC
 * dependency graph (see poc/cohort-decomp/decompose.mjs), packed into
 * contiguous spine runs under the bounds below. It cuts cohort-level
 * back-edges from 190 (regex) to 57.
 *
 * Embedded here rather than added as a TSV column on purpose: the D5 contract
 * is machine-checked code, and the queue TSV is generated data the check is
 * supposed to distrust. Putting the grouping in the data would let a
 * regenerated queue rewrite the contract without a code review.
 */
const COHORTS: Array<[string, string[]]> = [
  ["00", ["ReactFiberCacheComponent", "ReactFiberTreeContext", "ReactFiberStack", "ReactFiberLegacyContext", "ReactEventPriorities", "getComponentNameFromFiber", "ReactFiberComponentStack", "ReactCurrentFiber", "ReactCapturedValue", "ReactFiberActivityComponent"]],
  ["01", ["ReactStrictModeWarnings", "ReactFiberErrorLogger", "ReactFiberHydrationDiffs", "ReactFiberDuplicateViewTransitions", "ReactFiberAct", "ReactFiberDevToolsHook", "ReactFiberLane", "ReactFiberSuspenseComponent", "ReactFiberOffscreenComponent", "ReactFiberTreeReflection"]],
  ["02", ["ReactFiberTransitionTypes", "ReactFiberPerformanceTrack", "ReactFiberScope", "ReactProfilerTimer", "ReactFiberAsyncAction", "ReactFiberTracingMarkerComponent", "ReactFiberThenable", "ReactInternalTypes", "ReactFiberViewTransitionComponent", "ReactFiberRootScheduler"]],
  ["03", ["ReactFiberHostContext", "ReactFiberNewContext", "ReactFiberAsyncDispatcher", "ReactFiber", "ReactFiberHydrationContext", "ReactFiberRoot", "ReactFiberShellHydration", "ReactFiberSuspenseContext", "ReactFiberHiddenContext", "ReactFiberGestureScheduler"]],
  ["04", ["ReactFiberTransition", "ReactFiberUnwindWork", "ReactChildFiber", "ReactFiberCommitViewTransitions", "ReactFiberCompleteWork"]],
  ["05", ["ReactFiberCommitHostEffects", "ReactFiberClassUpdateQueue", "ReactFiberClassComponent", "ReactFiberConcurrentUpdates", "ReactFiberHotReloading", "ReactFiberCallUserSpace", "ReactFiberThrow"]],
  ["06", ["ReactFiberHooks", "ReactFiberReconciler"]],
  ["07", ["ReactFiberBeginWork", "ReactFiberCommitEffects"]],
  ["08", ["ReactFiberCommitWork"]],
  ["09", ["ReactFiberWorkLoop"]],
  ["10", ["ReactFiberApplyGesture"]],
];

/**
 * Hard bounds per cohort. MAX_LOC is the top of the ~4-6k smart zone one agent
 * converges in four implement/review rounds; it must also clear the largest
 * single module (ReactFiberWorkLoop, 5,246 LOC), which cannot be split.
 * MAX_MODULES bounds the review surface per round.
 */
const MAX_COHORT_LOC = 6000;
const MAX_COHORT_MODULES = 10;

/** The gate the old component stamped on every cohort. Never acceptable. */
const BLANKET_GATE = "noop-host reconciler suites (76 files / 1,039 cases)";

const TEST_DIR = (reactRepo: string) =>
  join(reactRepo, "packages", "react-reconciler", "src", "__tests__");

/** Parse the gating_tests column: `File-test.js(N),...` -> [{file, cases}]. */
const parseGating = (raw: string): Array<{ file: string; cases: number }> =>
  !raw
    ? []
    : raw.split(",").map((t) => {
        const m = /^(.+)\((\d+)\)$/.exec(t.trim());
        return m ? { file: m[1], cases: Number(m[2]) } : { file: t.trim(), cases: 0 };
      });

/**
 * Parse MODULE_QUEUE.tsv into landable work, and refuse a queue whose
 * decomposition is wrong — semantically, not just in shape.
 *
 * The D5 contract is a machine check, not advice. The old check verified only
 * counts (22 leaves, 59 SCC rows, 59 regex matches); this one verifies the
 * decomposition itself: every SCC module assigned exactly once, every cohort
 * non-empty and inside the size/LOC bounds, every cohort gated on real test
 * files that exist in the pinned react checkout, leaves exactly the 22
 * scc==="-" rows in order, and no cohort gated on the blanket suite.
 */
export function QueueParse({ c }: { c: FerricConfig }) {
  return (
    <Task id="queue-parse" output={outputs.frcQueue}>
      {() => {
        const lines = readFileSync(c.queuePath, "utf8").trim().split("\n").slice(1);
        const rows = lines.map((l) => {
          const [order, module_, loc, _fanIn, scc, deps, gating] = l.split("\t");
          return {
            order: Number(order),
            module: module_,
            loc: Number(loc),
            scc: (scc ?? "-").trim(),
            deps: (deps ?? "").trim() ? (deps ?? "").trim().split(",") : [],
            gate: (gating ?? "").trim(),
          };
        });

        const leafRows = rows.filter((r) => r.scc === "-");
        const sccRows = rows.filter((r) => r.scc !== "-");
        const sccSet = new Set(sccRows.map((r) => r.module));
        const byName = new Map(sccRows.map((r) => [r.module, r]));

        const fail = (why: string): never => {
          throw new Error(
            `D5_QUEUE_CONTRACT: ${why}. Regenerate MODULE_QUEUE.tsv (report-fable §4.4) or amend the COHORTS table in QueueParse.tsx.`,
          );
        };

        // Leaves: exactly the 22 scc==="-" rows, in queue order.
        const inFileOrder = leafRows.every((r, i) => i === 0 || leafRows[i - 1].order < r.order);
        if (leafRows.length !== 22 || !inFileOrder) {
          fail(`expected 22 leaf rows in queue order, got leaves=${leafRows.length} ordered=${inFileOrder}`);
        }

        const leaves: SliceDef[] = leafRows.map((r) => ({
          id: `m4-leaf-${r.module}`,
          kind: "leaf",
          modules: [r.module],
          gate: r.gate,
        }));

        if (sccRows.length !== 59) {
          fail(`expected one 59-module SCC, got scc=${sccRows.length}`);
        }

        // Intra-SCC reverse adjacency, for gate inheritance.
        const dependents = new Map(sccRows.map((r) => [r.module, [] as string[]]));
        for (const r of sccRows)
          for (const d of r.deps) if (sccSet.has(d)) dependents.get(d)!.push(r.module);

        /**
         * A module's gate tests: its own gating_tests, else the top-4 (by
         * cases) of its transitive intra-SCC dependents — the suites that
         * actually exercise it. Mirrors the TSV's own top4 convention.
         */
        const effectiveTests = (m: string): Array<{ file: string; cases: number }> => {
          const own = parseGating(byName.get(m)!.gate);
          if (own.length > 0) return own;
          const seen = new Set([m]);
          const queue = [m];
          const pool = new Map<string, number>();
          while (queue.length) {
            const cur = queue.shift()!;
            for (const dep of dependents.get(cur)!) {
              if (seen.has(dep)) continue;
              seen.add(dep);
              queue.push(dep);
              for (const t of parseGating(byName.get(dep)!.gate))
                pool.set(t.file, Math.max(pool.get(t.file) ?? 0, t.cases));
            }
          }
          return [...pool.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 4)
            .map(([file, cases]) => ({ file, cases }));
        };

        // Semantic contract: the COHORTS table must be an exact, bounded,
        // really-gated partition of the 59 SCC modules.
        const assignedCount = new Map<string, number>();
        const testDir = TEST_DIR(c.reactRepo);
        const cohorts: SliceDef[] = COHORTS.map(([suffix, mods]) => {
          if (mods.length === 0) fail(`cohort m4-cohort-${suffix} is empty`);
          if (mods.length > MAX_COHORT_MODULES) {
            fail(`cohort m4-cohort-${suffix} has ${mods.length} modules, over MAX_COHORT_MODULES=${MAX_COHORT_MODULES}`);
          }
          let loc = 0;
          const gatePool = new Map<string, number>();
          for (const m of mods) {
            const row = byName.get(m);
            if (!row) fail(`cohort m4-cohort-${suffix} names "${m}", which is not an SCC row in the queue`);
            assignedCount.set(m, (assignedCount.get(m) ?? 0) + 1);
            loc += row.loc;
            for (const t of effectiveTests(m))
              gatePool.set(t.file, Math.max(gatePool.get(t.file) ?? 0, t.cases));
          }
          if (loc > MAX_COHORT_LOC) {
            fail(`cohort m4-cohort-${suffix} is ${loc} LOC, over MAX_COHORT_LOC=${MAX_COHORT_LOC}`);
          }
          if (gatePool.size === 0) {
            fail(`cohort m4-cohort-${suffix} has an empty derived gate (no own or inheritable gating_tests)`);
          }
          const gate = [...gatePool.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([file, cases]) => `${file}(${cases})`)
            .join(",");
          if (gate === BLANKET_GATE) {
            fail(`cohort m4-cohort-${suffix} is gated on the blanket suite`);
          }
          for (const file of gatePool.keys()) {
            if (!existsSync(join(testDir, file))) {
              fail(`cohort m4-cohort-${suffix} gate lists ${file}, missing from ${testDir} in the pinned react checkout`);
            }
          }
          return { id: `m4-cohort-${suffix}`, kind: "cohort" as const, modules: mods, gate };
        });

        const duplicated = [...assignedCount.entries()].filter(([, n]) => n > 1).map(([m]) => m);
        const unassigned = sccRows.map((r) => r.module).filter((m) => !assignedCount.has(m));
        if (assignedCount.size !== 59 || duplicated.length > 0 || unassigned.length > 0) {
          fail(
            `COHORTS table must assign all 59 SCC modules exactly once; assigned=${assignedCount.size} duplicated=[${duplicated.join(",")}] unassigned=[${unassigned.join(",")}]`,
          );
        }

        return {
          totalRows: rows.length,
          leafCount: leaves.length,
          cohortCount: cohorts.length,
          sccModules: sccRows.length,
          slices: JSON.stringify([...leaves, ...cohorts]),
        };
      }}
    </Task>
  );
}
