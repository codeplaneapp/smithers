/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { GitHubIssuesEventSchema } from "@smthrs/integrations/github";
import { z } from "zod/v4";

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: GitHubIssuesEventSchema,
  result: z.object({
    repository: z.string(),
    issueNumber: z.number(),
    title: z.string(),
  }),
});

/**
 * Each declared `issues` delivery starts this workflow with the verified
 * GitHub payload as its validated input.
 */
export default smithers((ctx) => (
  <Workflow name="github-issue-listener">
    <Task id="result" output={outputs.result}>
      {() => ({
        repository: ctx.input.repository.full_name,
        issueNumber: ctx.input.issue.number,
        title: ctx.input.issue.title,
      })}
    </Task>
  </Workflow>
));
