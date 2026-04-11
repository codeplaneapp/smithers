import type { ExtractGraph } from "@smithers/graph/types";

const GRAPH_SPECIFIER = "@smithers/graph";
const LOCAL_GRAPH_SPECIFIER = "../../graph/src/index.ts";

type CoreModule = {
  extractGraph?: ExtractGraph;
};

async function importCoreModule(specifier: string): Promise<CoreModule | null> {
  try {
    return (await import(specifier)) as CoreModule;
  } catch {
    return null;
  }
}

export async function resolveExtractGraph(): Promise<ExtractGraph> {
  const modules = [
    await importCoreModule(GRAPH_SPECIFIER),
    await importCoreModule(LOCAL_GRAPH_SPECIFIER),
  ];
  for (const mod of modules) {
    const fn = mod?.extractGraph;
    if (typeof fn === "function") {
      return fn;
    }
  }
  throw new Error(
    "Unable to load extractGraph from @smithers/graph. " +
      "Install @smithers/graph and ensure it exports extractGraph.",
  );
}
