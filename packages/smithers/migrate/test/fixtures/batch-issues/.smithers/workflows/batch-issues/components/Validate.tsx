import { Task, tables, outputs } from "../smithers";
import { codex } from "../agents";
import ValidatePrompt from "../prompts/validate.mdx";
import type { LinearIssue } from "../schemas/issue";
import type { ImplementOutput } from "../schemas/implement";

interface ValidateProps {
  issue: LinearIssue;
  ctx: any;
}

export function Validate({ issue, ctx }: ValidateProps) {
  const id = issue.identifier;

  const implementOutput = ctx.latest(tables.implement, `${id}:implement`) as ImplementOutput | undefined;

  return (
    <Task
      id={`${id}:validate`}
      output={outputs.validate}
      agent={codex}
      timeoutMs={20 * 60 * 1000}
    >
      <ValidatePrompt
        issueIdentifier={id}
        issueTitle={issue.title}
        implementOutput={implementOutput}
      />
    </Task>
  );
}
