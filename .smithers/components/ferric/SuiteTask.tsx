/** @jsxImportSource smthrs */
import { Task, outputs } from "./ferricSmithers";
import { assertNotInfra, sh } from "./ferricShell";

/**
 * Run one leg of the oracle and persist the measured result.
 *
 * A missing or unparseable `PASSING=n/m` line, or a zero denominator, is a red —
 * never a pass. An audited implementation treated a regex miss plus exit 0 as
 * green, which let a suite that ran nothing certify a slice.
 */
export function SuiteTask(props: { id: string; leg: string; args: string[]; repo: string }) {
  return (
    <Task id={props.id} output={outputs.frcSuite} retries={2}>
      {async () => {
        const r = await sh(["bash", "scripts/ferric/oracle.sh", ...props.args], props.repo);
        assertNotInfra(r, props.id);
        const m = /PASSING=(\d+)\/(\d+)(?:\s+XFAIL_C=(\d+))?/.exec(r.out);
        const passing = m ? Number(m[1]) : 0;
        const total = m ? Number(m[2]) : 0;
        return {
          leg: props.leg,
          passingCount: passing,
          totalCount: total,
          green: r.ok && !!m && passing === total && total > 0,
          xfailBucketC: m?.[3] ? Number(m[3]) : 0,
        };
      }}
    </Task>
  );
}
