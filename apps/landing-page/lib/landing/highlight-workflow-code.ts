import { codeToHtml } from "shiki";

const smithersWorkflowTheme = {
  name: "smithers-workflow",
  type: "dark" as const,
  fg: "#f2ede4",
  bg: "#00000000",
  settings: [
    { settings: { foreground: "#f2ede4" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#9a9288", fontStyle: "italic" },
    },
    {
      scope: ["string", "string.quoted", "constant.other.placeholder"],
      settings: { foreground: "#cab16a" },
    },
    {
      scope: [
        "entity.name.tag",
        "support.class.component",
        "entity.name.type",
        "support.type.property-name",
      ],
      settings: { foreground: "#cab16a" },
    },
    {
      scope: ["entity.other.attribute-name", "meta.tag"],
      settings: { foreground: "#9a9288" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.definition.tag"],
      settings: { foreground: "#8a7a52" },
    },
  ],
};

let cachedHtml: string | undefined;

export async function highlightWorkflowTsx(code: string) {
  if (cachedHtml) return cachedHtml;

  cachedHtml = await codeToHtml(code, {
    lang: "tsx",
    theme: smithersWorkflowTheme,
  });

  return cachedHtml;
}
