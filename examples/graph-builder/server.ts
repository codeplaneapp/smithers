import { renderFrame } from "smithers-orchestrator";
import { buildPlanTree } from "smithers-orchestrator/graph";
import type { SmithersWorkflow, TaskDescriptor, XmlNode } from "smithers-orchestrator";
import { dirname, extname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const htmlPath = join(import.meta.dir, "index.html");
const html = await Bun.file(htmlPath).text();
const tmpDir = join(import.meta.dir, ".tmp");
mkdirSync(tmpDir, { recursive: true });

type BuilderTaskNode = {
  id: string;
  kind: "agent" | "shell" | "approval";
  title: string;
  outputKey: string;
  schema: string;
  prompt?: string;
  command?: string;
  message?: string;
};

type BuilderContainerNode = {
  id: string;
  kind: "sequence" | "parallel" | "loop" | "branch";
  title: string;
  children: BuilderNode[];
  loopId?: string;
  maxIterations?: number;
  condition?: string;
};

type BuilderNode = BuilderTaskNode | BuilderContainerNode;

type BuilderDocument = {
  version: 1;
  workflowName: string;
  orientation: "horizontal" | "vertical";
  positions: Record<string, { x: number; y: number }>;
  root: BuilderContainerNode;
};

function parseJson(text: string | undefined, fallback: any = {}) {
  if (!text || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeTaskNode(node: any): BuilderTaskNode {
  const kind = node.kind === "shell" || node.kind === "approval" ? node.kind : "agent";
  const outputKey = String(node.outputKey ?? node.id ?? "output");
  return {
    id: String(node.id ?? "task"),
    kind,
    title: String(node.title ?? node.id ?? "Task"),
    outputKey,
    schema: String(
      node.schema ??
        (kind === "approval"
          ? 'z.object({ approved: z.boolean(), note: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable() })'
          : 'z.object({ result: z.string() })'),
    ),
    prompt: typeof node.prompt === "string" ? node.prompt : undefined,
    command: typeof node.command === "string" ? node.command : undefined,
    message: typeof node.message === "string" ? node.message : undefined,
  };
}

function normalizeNode(node: any): BuilderNode {
  const kind = String(node?.kind ?? "sequence");
  if (kind === "agent" || kind === "shell" || kind === "approval") {
    return normalizeTaskNode(node);
  }
  const containerKind =
    kind === "parallel" || kind === "loop" || kind === "branch" ? kind : "sequence";
  const base: BuilderContainerNode = {
    id: String(node?.id ?? `${containerKind}-1`),
    kind: containerKind,
    title: String(node?.title ?? containerKind),
    children: Array.isArray(node?.children) ? node.children.map(normalizeNode) : [],
  };
  if (containerKind === "loop") {
    base.loopId = typeof node?.loopId === "string" ? node.loopId : base.id;
    base.maxIterations =
      typeof node?.maxIterations === "number" && Number.isFinite(node.maxIterations)
        ? node.maxIterations
        : 3;
  }
  if (containerKind === "branch") {
    base.condition = typeof node?.condition === "string" ? node.condition : "true";
  }
  return base;
}

function normalizeDocument(doc: any): BuilderDocument {
  const root = normalizeNode(doc?.root ?? { kind: "sequence", id: "root-sequence", title: "Main sequence", children: [] });
  const rootContainer = root.kind === "sequence" || root.kind === "parallel" || root.kind === "loop" || root.kind === "branch"
    ? root
    : { id: "root-sequence", kind: "sequence" as const, title: "Main sequence", children: [root] };
  return {
    version: 1,
    workflowName: String(doc?.workflowName ?? "workflow"),
    orientation: doc?.orientation === "vertical" ? "vertical" : "horizontal",
    positions: typeof doc?.positions === "object" && doc?.positions ? doc.positions : {},
    root: rootContainer,
  };
}

function isValidIdentifier(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function outputsAccess(key: string) {
  return isValidIdentifier(key) ? `outputs.${key}` : `outputs[${JSON.stringify(key)}]`;
}

function quoteObjectKey(key: string) {
  return isValidIdentifier(key) ? key : JSON.stringify(key);
}

function textFromXml(node: XmlNode | null): string {
  if (!node) return "";
  if (node.kind === "text") return node.text;
  return node.children.map(textFromXml).join("").trim();
}

function zodToSource(schema: any): string {
  if (!schema) return "z.object({ result: z.string() })";
  const def = schema?._def;
  const typeName = def?.typeName ?? def?.type;
  switch (typeName) {
    case "ZodString":
    case "string":
      return "z.string()";
    case "ZodNumber":
    case "number":
      return "z.number()";
    case "ZodBoolean":
    case "boolean":
      return "z.boolean()";
    case "ZodLiteral":
    case "literal":
      return `z.literal(${JSON.stringify(def?.value)})`;
    case "ZodAny":
    case "any":
      return "z.any()";
    case "ZodUnknown":
    case "unknown":
      return "z.unknown()";
    case "ZodArray":
    case "array": {
      const inner = def?.element ?? def?.type;
      return `z.array(${zodToSource(inner)})`;
    }
    case "ZodEnum":
    case "enum": {
      const values = Array.isArray(def?.values)
        ? def.values
        : def?.entries && typeof def.entries === "object"
          ? Object.keys(def.entries)
          : ["value"];
      return `z.enum([${values.map((v: string) => JSON.stringify(v)).join(", ")}])`;
    }
    case "ZodObject":
    case "object": {
      const shape = schema.shape ?? def?.shape;
      const entries = typeof shape === "function" ? shape() : shape;
      if (!entries || typeof entries !== "object") return "z.object({})";
      const fields = Object.entries(entries).map(
        ([key, value]) => `${quoteObjectKey(key)}: ${zodToSource(value)}`,
      );
      return `z.object({ ${fields.join(", ")} })`;
    }
    case "ZodNullable":
    case "nullable":
      return `${zodToSource(def?.inner ?? def?.innerType)}.nullable()`;
    case "ZodOptional":
    case "optional":
      return `${zodToSource(def?.inner ?? def?.innerType)}.optional()`;
    case "ZodUnion":
    case "union": {
      const options = def?.options ?? [];
      return `z.union([${options.map((o: any) => zodToSource(o)).join(", ")}])`;
    }
    case "ZodDefault":
    case "default":
      return zodToSource(def?.innerType ?? def?.inner);
    default:
      return "z.any()";
  }
}

function inferTaskKind(desc?: TaskDescriptor) {
  if (desc?.needsApproval) return "approval" as const;
  return "agent" as const;
}

function schemaForDescriptor(desc?: TaskDescriptor) {
  if (desc?.needsApproval) {
    return 'z.object({ approved: z.boolean(), note: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable() })';
  }
  return zodToSource(desc?.outputSchema ?? desc?.outputRef);
}

function nodeIdForTag(tag: string, path: number[]) {
  return `${tag.replace(/^smithers:/, "")}-${path.join("-") || "0"}`;
}

function snapshotToDocument(
  filePath: string,
  snapshot: { xml: XmlNode | null; tasks: TaskDescriptor[] },
): { document: BuilderDocument; warnings: string[] } {
  const warnings: string[] = [];
  const taskMap = new Map(snapshot.tasks.map((t) => [t.nodeId, t]));

  function walk(node: XmlNode, path: number[]): BuilderNode | null {
    if (node.kind === "text") return null;
    const childNodes = node.children
      .map((child, index) => walk(child, [...path, index]))
      .filter(Boolean) as BuilderNode[];

    switch (node.tag) {
      case "smithers:workflow":
        return {
          id: "root-sequence",
          kind: "sequence",
          title: String(node.props.name ?? parse(filePath).name ?? "Workflow"),
          children: childNodes,
        };
      case "smithers:sequence":
        return {
          id: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          kind: "sequence",
          title: String(node.props.label ?? "Sequence"),
          children: childNodes,
        };
      case "smithers:parallel":
      case "smithers:merge-queue":
        return {
          id: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          kind: "parallel",
          title: String(node.props.label ?? "Parallel"),
          children: childNodes,
        };
      case "smithers:ralph":
        return {
          id: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          kind: "loop",
          title: String(node.props.label ?? node.props.id ?? "Loop"),
          loopId: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          maxIterations: Number(node.props.maxIterations ?? 3),
          children: childNodes,
        };
      case "smithers:branch": {
        const chosenTrue = String(node.props.if ?? "true") === "true";
        warnings.push(
          `Imported branch at ${nodeIdForTag(node.tag, path)} from rendered output. Only the active branch path was present in the rendered XML.`,
        );
        return {
          id: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          kind: "branch",
          title: String(node.props.label ?? "Branch"),
          condition:
            typeof node.props.if === "string"
              ? `/* imported branch; inactive path unavailable */ ${node.props.if}`
              : "true",
          children: [
            {
              id: `${nodeIdForTag(node.tag, path)}-true`,
              kind: "sequence",
              title: "If true",
              children: chosenTrue ? childNodes : [],
            },
            {
              id: `${nodeIdForTag(node.tag, path)}-false`,
              kind: "sequence",
              title: "If false",
              children: chosenTrue ? [] : childNodes,
            },
          ],
        };
      }
      case "smithers:worktree":
        warnings.push(`Imported worktree ${node.props.id ?? nodeIdForTag(node.tag, path)} as a grouped sequence.`);
        return {
          id: String(node.props.id ?? nodeIdForTag(node.tag, path)),
          kind: "sequence",
          title: String(node.props.id ? `Worktree ${node.props.id}` : "Worktree"),
          children: childNodes,
        };
      case "smithers:task": {
        const id = String(node.props.id ?? nodeIdForTag(node.tag, path));
        const desc = taskMap.get(id);
        const kind = inferTaskKind(desc);
        if (kind === "approval") {
          return {
            id,
            kind,
            title: String(desc?.label ?? id),
            outputKey: String(desc?.outputTableName ?? `${id}_approval`),
            schema: schemaForDescriptor(desc),
            message: String(
              desc?.meta?.requestSummary ?? desc?.label ?? (textFromXml(node) || "Approval required"),
            ),
          };
        }
        return {
          id,
          kind,
          title: String(desc?.label ?? id),
          outputKey: String(desc?.outputTableName ?? id),
          schema: schemaForDescriptor(desc),
          prompt: String(desc?.prompt ?? (textFromXml(node) || `Imported Smithers task ${id}`)),
        };
      }
      default:
        if (childNodes.length === 1) return childNodes[0]!;
        if (childNodes.length > 1) {
          warnings.push(`Imported unsupported tag ${node.tag} as a grouped sequence.`);
          return {
            id: nodeIdForTag(node.tag, path),
            kind: "sequence",
            title: node.tag.replace(/^smithers:/, ""),
            children: childNodes,
          };
        }
        return null;
    }
  }

  const root = snapshot.xml ? walk(snapshot.xml, [0]) : null;
  const normalizedRoot = root && (root.kind === "sequence" || root.kind === "parallel" || root.kind === "loop" || root.kind === "branch")
    ? root
    : {
        id: "root-sequence",
        kind: "sequence" as const,
        title: parse(filePath).name,
        children: root ? [root] : [],
      };

  return {
    document: normalizeDocument({
      workflowName: parse(filePath).name,
      orientation: "horizontal",
      positions: {},
      root: normalizedRoot,
    }),
    warnings,
  };
}

async function loadWorkflow(absPath: string): Promise<SmithersWorkflow<any>> {
  const href = pathToFileURL(absPath).href + `?v=${Date.now()}`;
  const mod = await import(href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function createPlaceholder() {
  const fn = (() => "") as any;
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => "";
      if (prop === "toJSON") return () => null;
      if (prop === "length") return 0;
      return createPlaceholder();
    },
    apply() {
      return createPlaceholder();
    },
  });
}

async function renderWorkflow(absPath: string, input: any) {
  const workflow = await loadWorkflow(absPath);
  const missing = createPlaceholder();
  const ctx = {
    runId: "graph-builder-import",
    iteration: 0,
    input: input ?? {},
    outputs: {},
    output() {
      return missing;
    },
    outputMaybe() {
      return undefined;
    },
    latest() {
      return undefined;
    },
    latestArray() {
      return [];
    },
    iterationCount() {
      return 0;
    },
  } as any;
  return renderFrame(workflow, ctx, { baseRootDir: dirname(absPath) });
}

function resolveWorkflowPaths(userPath: string) {
  const abs = resolve(process.cwd(), userPath);
  if (!existsSync(abs)) {
    throw new Error(`Path not found: ${abs}`);
  }
  const stats = statSync(abs);
  if (stats.isDirectory()) {
    return {
      inputPath: abs,
      graphPath: join(abs, "workflow.graph.json"),
      tsxPath: join(abs, "workflow.tsx"),
    };
  }
  if (abs.endsWith(".graph.json")) {
    return {
      inputPath: abs,
      graphPath: abs,
      tsxPath: abs.replace(/\.graph\.json$/, ".tsx"),
    };
  }
  if (extname(abs) === ".tsx" || extname(abs) === ".ts") {
    return {
      inputPath: abs,
      graphPath: abs.replace(/\.(tsx|ts)$/, ".graph.json"),
      tsxPath: abs,
    };
  }
  throw new Error("Use a path to workflow.tsx, workflow.ts, workflow.graph.json, or a directory containing workflow files.");
}

function statInfo(path: string | null) {
  if (!path || !existsSync(path)) return null;
  const stats = statSync(path);
  return { path, mtimeMs: stats.mtimeMs, size: stats.size };
}

async function loadLocalWorkflow(userPath: string, input: any) {
  const paths = resolveWorkflowPaths(userPath);
  const warnings: string[] = [];
  const graphStat = statInfo(paths.graphPath);
  const tsxStat = statInfo(paths.tsxPath);

  if (graphStat && tsxStat && tsxStat.mtimeMs > graphStat.mtimeMs) {
    warnings.push("workflow.tsx is newer than workflow.graph.json. The builder loaded the graph sidecar as the source of truth.");
  }

  if (graphStat) {
    const document = normalizeDocument(parseJson(readFileSync(paths.graphPath, "utf8")));
    const code = tsxStat ? readFileSync(paths.tsxPath, "utf8") : null;
    return {
      mode: "graph",
      roundTripSafe: true,
      warnings,
      document,
      code,
      paths,
      stats: { graph: graphStat, tsx: tsxStat },
    };
  }

  if (!tsxStat) {
    throw new Error(`No workflow.graph.json or workflow.tsx found for path: ${userPath}`);
  }

  const snapshot = await renderWorkflow(paths.tsxPath, input);
  const imported = snapshotToDocument(paths.tsxPath, snapshot);
  const code = readFileSync(paths.tsxPath, "utf8");
  return {
    mode: "tsx-import",
    roundTripSafe: false,
    warnings: imported.warnings,
    document: imported.document,
    code,
    paths,
    stats: { graph: graphStat, tsx: tsxStat },
  };
}

async function validateGeneratedCode(code: string, input: any) {
  const filePath = join(tmpDir, `validate-${Date.now()}-${Math.random().toString(36).slice(2)}.tsx`);
  writeFileSync(filePath, code, "utf8");
  try {
    const snapshot = await renderWorkflow(filePath, input);
    return {
      ok: true,
      plan: buildPlanTree(snapshot.xml ?? null),
      taskIds: snapshot.tasks.map((t) => t.nodeId),
    };
  } catch (error: any) {
    return {
      ok: false,
      error: error?.stack ?? error?.message ?? String(error),
    };
  } finally {
    try {
      rmSync(filePath, { force: true });
    } catch {}
  }
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function saveLocalWorkflow(userPath: string, document: BuilderDocument, code: string) {
  const explicit = resolve(process.cwd(), userPath);
  let graphPath: string;
  let tsxPath: string;

  if (explicit.endsWith(".graph.json")) {
    graphPath = explicit;
    tsxPath = explicit.replace(/\.graph\.json$/, ".tsx");
  } else if (extname(explicit) === ".tsx" || extname(explicit) === ".ts") {
    tsxPath = explicit;
    graphPath = explicit.replace(/\.(tsx|ts)$/, ".graph.json");
  } else if (existsSync(explicit) && statSync(explicit).isDirectory()) {
    graphPath = join(explicit, "workflow.graph.json");
    tsxPath = join(explicit, "workflow.tsx");
  } else {
    graphPath = join(explicit, "workflow.graph.json");
    tsxPath = join(explicit, "workflow.tsx");
  }

  ensureDir(graphPath);
  ensureDir(tsxPath);
  writeFileSync(graphPath, JSON.stringify(document, null, 2), "utf8");
  writeFileSync(tsxPath, code, "utf8");
  return { graphPath, tsxPath, stats: { graph: statInfo(graphPath), tsx: statInfo(tsxPath) } };
}

function openNativeFilePicker(kind: "file" | "directory" = "file"): Promise<string | null> {
  return new Promise((resolve) => {
    const isMac = platform() === "darwin";
    if (!isMac) {
      // Fallback: prompt on stdin
      process.stdout.write("Enter workflow path: ");
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (chunk: string) => {
        data = chunk.trim();
        resolve(data || null);
      });
      return;
    }
    const script =
      kind === "directory"
        ? 'tell application "System Events" to set f to POSIX path of (choose folder with prompt "Select workflow directory")'
        : 'tell application "System Events" to set f to POSIX path of (choose file with prompt "Select workflow file" of type {"tsx","ts","json"})';
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

function findWorkflowFiles(baseDir: string, maxDepth: number): Array<{ path: string; hasGraph: boolean }> {
  const results: Array<{ path: string; hasGraph: boolean }> = [];
  function scan(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".jj" || entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".graph.json")) {
          if (entry.name.endsWith(".graph.json")) {
            results.push({ path: full, hasGraph: true });
          } else if (entry.name.endsWith(".tsx") && !results.some((r) => r.path === full.replace(/\.tsx$/, ".graph.json"))) {
            results.push({ path: full, hasGraph: existsSync(full.replace(/\.tsx$/, ".graph.json")) });
          }
        }
      }
    } catch {}
  }
  scan(baseDir, 0);
  return results.slice(0, 30);
}

Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/api/plan" && req.method === "POST") {
        const body = await req.json() as { xml?: XmlNode | null };
        return Response.json(buildPlanTree(body.xml ?? null));
      }

      if (url.pathname === "/api/pick-file" && req.method === "POST") {
        const body = await req.json() as { kind?: "file" | "directory" };
        const picked = await openNativeFilePicker(body.kind ?? "file");
        if (!picked) return Response.json({ cancelled: true });
        const inputJson = (await req.clone().json().catch(() => ({})) as any).inputJson ?? "{}";
        const result = await loadLocalWorkflow(picked, parseJson(inputJson, {}));
        return Response.json({ cancelled: false, path: picked, ...result });
      }

      if (url.pathname === "/api/recent-workflows" && req.method === "GET") {
        const cwd = process.cwd();
        const parentDir = dirname(cwd);
        const repoRoot = dirname(parentDir);
        const results = [
          ...findWorkflowFiles(cwd, 4),
          ...findWorkflowFiles(parentDir, 3),
          ...findWorkflowFiles(repoRoot, 2),
        ];
        const seen = new Set<string>();
        const deduped = results.filter((r) => { if (seen.has(r.path)) return false; seen.add(r.path); return true; });
        return Response.json({ cwd, workflows: deduped });
      }

      if (url.pathname === "/api/load-local" && req.method === "POST") {
        const body = await req.json() as { path: string; inputJson?: string };
        const result = await loadLocalWorkflow(body.path, parseJson(body.inputJson, {}));
        return Response.json(result);
      }

      if (url.pathname === "/api/stat-local" && req.method === "POST") {
        const body = await req.json() as { path: string };
        const paths = resolveWorkflowPaths(body.path);
        return Response.json({ paths, stats: { graph: statInfo(paths.graphPath), tsx: statInfo(paths.tsxPath) } });
      }

      if (url.pathname === "/api/import-graph" && req.method === "POST") {
        const body = await req.json() as { content: string };
        return Response.json({ document: normalizeDocument(parseJson(body.content)) });
      }

      if (url.pathname === "/api/import-tsx" && req.method === "POST") {
        const body = await req.json() as { code: string; inputJson?: string };
        const tmpPath = join(tmpDir, `import-${Date.now()}-${Math.random().toString(36).slice(2)}.tsx`);
        writeFileSync(tmpPath, body.code, "utf8");
        try {
          const snapshot = await renderWorkflow(tmpPath, parseJson(body.inputJson, {}));
          const imported = snapshotToDocument(tmpPath, snapshot);
          return Response.json({
            mode: "tsx-import",
            roundTripSafe: false,
            warnings: [
              "Uploaded TSX import is best-effort. Relative project dependencies are not available unless you load from a real local path.",
              ...imported.warnings,
            ],
            document: imported.document,
            code: body.code,
          });
        } finally {
          try {
            rmSync(tmpPath, { force: true });
          } catch {}
        }
      }

      if (url.pathname === "/api/validate" && req.method === "POST") {
        const body = await req.json() as { code: string; inputJson?: string };
        return Response.json(await validateGeneratedCode(body.code, parseJson(body.inputJson, {})));
      }

      if (url.pathname === "/api/save-local" && req.method === "POST") {
        const body = await req.json() as { path: string; document: BuilderDocument; code: string; inputJson?: string };
        const document = normalizeDocument(body.document);
        const validation = await validateGeneratedCode(body.code, parseJson(body.inputJson, {}));
        if (!validation.ok) {
          return Response.json({ ok: false, validation }, { status: 400 });
        }
        const saved = saveLocalWorkflow(body.path, document, body.code);
        return Response.json({ ok: true, saved, validation });
      }

      return new Response("Not found", { status: 404 });
    } catch (error: any) {
      return Response.json(
        {
          ok: false,
          error: error?.stack ?? error?.message ?? String(error),
        },
        { status: 500 },
      );
    }
  },
});

console.log("Graph builder running at http://localhost:8787");
