/** @jsxImportSource smthrs */
import { Task, outputs } from "./ferricSmithers";
import { assertNotInfra, sh } from "./ferricShell";

/**
 * Differential fuzzing against upstream React. `clean` requires the full
 * requested case count AND zero divergences, so a short run cannot pass.
 */
export function FuzzTask(props: { id: string; mode: string; cases: number; repo: string }) {
  return (
    <Task id={props.id} output={outputs.frcFuzz} retries={2}>
      {async () => {
        const r = await sh(["bash", "scripts/ferric/fuzz.sh", props.mode, "--cases", String(props.cases)], props.repo);
        assertNotInfra(r, props.id);
        const m = /CASES=(\d+)\s+DIVERGENCES=(\d+)/.exec(r.out);
        return {
          mode: props.mode,
          casesRun: m ? Number(m[1]) : 0,
          divergences: m ? Number(m[2]) : -1,
          clean: !!m && Number(m[1]) >= props.cases && m[2] === "0",
        };
      }}
    </Task>
  );
}
