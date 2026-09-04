import { Task, outputs } from "../smithers";
import { claude } from "../agents";
import ResearchPrompt from "../prompts/research.mdx";
import type { LinearIssue } from "../schemas/issue";

interface ResearchProps {
  issue: LinearIssue;
}

export function Research({ issue }: ResearchProps) {
  const id = issue.identifier;

  return (
    <Task
      id={`${id}:research`}
      output={outputs.research}
      agent={claude}
      timeoutMs={15 * 60 * 1000}
    >
      <ResearchPrompt
        issueIdentifier={id}
        issueTitle={issue.title}
        issueDescription={issue.description ?? "No description provided"}
      />
    </Task>
  );
}
