/** @jsxImportSource smithers-orchestrator */
import { Task, outputs } from "./ferricSmithers";
import { assertNotInfra, sh } from "./ferricShell";

/**
 * One benchmark cell, judged against the contract frozen at M0.
 *
 * The pass predicate is supplied by the caller because the thresholds differ per
 * workload (client update ops cap at 1.10x; SSR has a 0.95x floor). A missing
 * ratio is -1, which fails every predicate rather than defaulting to success.
 */
export function BenchTask(props: {
  id: string;
  bench: string;
  pass: (ratioX1000: number) => boolean;
  repo: string;
}) {
  return (
    <Task id={props.id} output={outputs.frcBench} retries={2}>
      {async () => {
        const r = await sh(["bash", "scripts/ferric/bench.sh", props.bench], props.repo);
        assertNotInfra(r, props.id);
        const m = /RATIO_X1000=(\d+)/.exec(r.out);
        const ratio = m ? Number(m[1]) : -1;
        return {
          bench: props.bench,
          ratioX1000: ratio,
          withinContract: m != null && props.pass(ratio),
        };
      }}
    </Task>
  );
}
