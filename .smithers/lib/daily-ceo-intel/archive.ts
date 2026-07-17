import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudflareCreds } from "./cloudflare";
import { putR2Object } from "./cloudflare";
import type { ArchiveOutput, RenderOutput } from "./schemas";

function writeLocal(render: RenderOutput, issueDateEt: string, reportsDir: string): ArchiveOutput {
  mkdirSync(reportsDir, { recursive: true });
  const paths = {
    md: join(reportsDir, `${issueDateEt}.md`),
    html: join(reportsDir, `${issueDateEt}.html`),
    json: join(reportsDir, `${issueDateEt}.json`),
  };
  writeFileSync(paths.md, render.markdown, "utf8");
  writeFileSync(paths.html, render.html, "utf8");
  writeFileSync(paths.json, render.issueJson, "utf8");
  const bytesWritten = Buffer.byteLength(render.markdown, "utf8") + Buffer.byteLength(render.html, "utf8") + Buffer.byteLength(render.issueJson, "utf8");
  return { mode: "local", paths, bytesWritten, summary: `Archived locally under ${reportsDir}/${issueDateEt}.*` };
}

export async function archiveIssue(
  render: RenderOutput,
  issueDateEt: string,
  effectiveMode: "archive-only" | "publish",
  cfCredsPresent: boolean,
  creds: CloudflareCreds | null,
  reportsDir: string,
): Promise<ArchiveOutput> {
  const useR2 = effectiveMode === "publish" && cfCredsPresent && creds !== null;
  if (!useR2) return writeLocal(render, issueDateEt, reportsDir);

  const keys = {
    md: `artifacts/${issueDateEt}/report.md`,
    html: `artifacts/${issueDateEt}/report.html`,
    json: `artifacts/${issueDateEt}/report.json`,
  };
  try {
    await putR2Object(creds, keys.md, render.markdown, "text/markdown; charset=utf-8");
    await putR2Object(creds, keys.html, render.html, "text/html; charset=utf-8");
    await putR2Object(creds, keys.json, render.issueJson, "application/json; charset=utf-8");
    const bytesWritten = Buffer.byteLength(render.markdown, "utf8") + Buffer.byteLength(render.html, "utf8") + Buffer.byteLength(render.issueJson, "utf8");
    return {
      mode: "r2",
      paths: { md: `r2:${keys.md}`, html: `r2:${keys.html}`, json: `r2:${keys.json}` },
      bytesWritten,
      summary: `Archived to R2 bucket under artifacts/${issueDateEt}/.`,
    };
  } catch (error) {
    const fallback = writeLocal(render, issueDateEt, reportsDir);
    return { ...fallback, summary: `R2 archive failed (${error instanceof Error ? error.message : String(error)}); fell back to local: ${fallback.summary}` };
  }
}
