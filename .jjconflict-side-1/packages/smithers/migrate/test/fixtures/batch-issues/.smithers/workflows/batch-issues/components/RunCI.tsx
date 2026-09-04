import { Task, outputs } from "../smithers";
import type { LinearIssue } from "../schemas/issue";

interface RunCIProps {
  issue: LinearIssue;
}

export function RunCI({ issue }: RunCIProps) {
  const id = issue.identifier;
  const worktreePath = `/tmp/smithers-batch/${id}`;
  return (
    <Task id={`${id}:ci`} output={outputs.ci} timeoutMs={30 * 60 * 1000}>
      {async () => {
        const start = Date.now();

        const testResult = await Bun.$`make test-go`.cwd(worktreePath).quiet().nothrow();
        const testOutput = testResult.text();

        const buildResult = await Bun.$`make build-go && make build-cli`.cwd(worktreePath).quiet().nothrow();
        const buildOutput = buildResult.text();

        const duration = Math.round((Date.now() - start) / 1000);
        const passed = testResult.exitCode === 0 && buildResult.exitCode === 0;

        return { passed, testOutput, buildOutput, duration };
      }}
    </Task>
  );
}
