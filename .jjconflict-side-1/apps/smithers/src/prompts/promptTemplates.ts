/** A reusable prompt template; {target} is the single fill slot. */
export type PromptTemplate = {
  id: string;
  name: string;
  field: string;
  body: string;
};

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "refactor",
    name: "Refactor",
    field: "file or module",
    body: "Refactor {target} for clarity. Keep behaviour identical; add no new deps.",
  },
  {
    id: "bugfix",
    name: "Bugfix",
    field: "failing test or symptom",
    body: "Find the root cause of {target} and fix it. Add a regression test.",
  },
  {
    id: "spec",
    name: "Write spec",
    field: "feature",
    body: "Write a short implementation spec for {target}: goal, API, edge cases.",
  },
  {
    id: "review",
    name: "Review",
    field: "diff or PR",
    body: "Review {target} for correctness and reuse. Be terse; cite file:line.",
  },
];

export function fillTemplate(template: PromptTemplate, target: string): string {
  return template.body.replace("{target}", target || `<${template.field}>`);
}
