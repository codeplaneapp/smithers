import type { ChangedFile } from "./changedFileSchema";
import { classifyChangeRole } from "./classifyChangeRole";
import { describeChange } from "./describeChange";
import type { Story, StoryBlock, StoryChapter } from "./storySchema";

const groupedRoots = new Set(["apps", "packages", "examples", "src"]);

function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "repository root";
  if (parts.length > 2 && groupedRoots.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function insertionsOf(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + file.insertions, 0);
}

function deletionsOf(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + file.deletions, 0);
}

function churnOf(files: ChangedFile[]): number {
  return insertionsOf(files) + deletionsOf(files);
}

function byChurnDesc(a: ChangedFile, b: ChangedFile): number {
  const churn = b.insertions + b.deletions - (a.insertions + a.deletions);
  return churn !== 0 ? churn : a.path.localeCompare(b.path);
}

function proseBlock(text: string): StoryBlock {
  return { kind: "prose", text, path: "", intro: "", title: "", mermaid: "" };
}

function diffBlock(file: ChangedFile): StoryBlock {
  return { kind: "diff", path: file.path, intro: describeChange(file), text: "", title: "", mermaid: "" };
}

function chapter(title: string, narrative: string, files: ChangedFile[]): StoryChapter {
  return {
    title,
    blocks: [proseBlock(narrative), ...[...files].sort(byChurnDesc).map(diffBlock)],
  };
}

/**
 * Deterministic story used when no narrator agent ran (or its output was
 * unusable): code areas by churn, then configuration, tests, and docs — one
 * prose block then diff blocks per chapter. Not as good as a narrated story,
 * but already a logical reading order instead of an alphabetical file list.
 */
export function fallbackStory(files: ChangedFile[]): Story {
  const code = new Map<string, ChangedFile[]>();
  const config: ChangedFile[] = [];
  const tests: ChangedFile[] = [];
  const docs: ChangedFile[] = [];
  for (const file of files) {
    const role = classifyChangeRole(file.path);
    if (role === "config") config.push(file);
    else if (role === "tests") tests.push(file);
    else if (role === "docs") docs.push(file);
    else {
      const area = areaOf(file.path);
      code.set(area, [...(code.get(area) ?? []), file]);
    }
  }

  const codeAreas = [...code.entries()].sort((a, b) => churnOf(b[1]) - churnOf(a[1]) || a[0].localeCompare(b[0]));
  const chapters: StoryChapter[] = [];
  for (const [area, areaFiles] of codeAreas) {
    const title = chapters.length === 0 ? `The main change: ${area}` : `Alongside: ${area}`;
    const narrative = `${areaFiles.length} file(s) changed in ${area} (+${insertionsOf(areaFiles)} −${deletionsOf(areaFiles)}).`;
    chapters.push(chapter(title, narrative, areaFiles));
  }

  if (config.length > 0) {
    chapters.push(chapter("Wiring and configuration", "Build, dependency, and configuration changes that support the work above.", config));
  }
  if (tests.length > 0) {
    chapters.push(chapter("The proof: tests", "Tests added or updated for this change.", tests));
  }
  if (docs.length > 0) {
    chapters.push(chapter("The paper trail: docs", "Documentation that records the change.", docs));
  }

  return {
    headline: `${files.length} file(s) changed (+${insertionsOf(files)} −${deletionsOf(files)}) across ${chapters.length} area(s)`,
    synopsis: chapters.length > 0 ? `Reading order: ${chapters.map((c) => c.title).join("; ")}.` : "No changes detected.",
    chapters,
  };
}
