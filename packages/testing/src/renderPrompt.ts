import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "@smithers-orchestrator/components/markdownComponents";

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderPrompt(prompt: unknown): string {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  if (typeof prompt === "number" || typeof prompt === "boolean") return String(prompt);
  if (React.isValidElement(prompt)) {
    const element = prompt as React.ReactElement<Record<string, unknown>>;
    return decodeHtmlEntities(renderToStaticMarkup(React.cloneElement(element, { components: markdownComponents }))).trim();
  }
  return decodeHtmlEntities(renderToStaticMarkup(React.createElement(React.Fragment, null, prompt as React.ReactNode))).trim();
}
