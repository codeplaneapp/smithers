import { highlightWorkflowTsx } from "@/lib/landing/highlight-workflow-code";
import { WORKFLOW_TSX_CODE } from "@/lib/landing/content";

export async function WorkflowTsxReveal() {
  const html = await highlightWorkflowTsx(WORKFLOW_TSX_CODE);

  return (
    <div>
      <div
        className="workflow-tsx-code overflow-x-auto rounded-lg border border-border bg-background/40 p-3 sm:p-4 [&_code]:block [&_code]:font-mono [&_code]:text-[10px] [&_code]:leading-relaxed sm:[&_code]:text-[11px] [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <p className="mt-3 text-center text-xs text-muted-foreground">
        TSX or MDX — readable, diffable, agent-writable. Or pick a built-in recipe.
      </p>
    </div>
  );
}
