/**
 * eve-style defineAgent: compiles an agent/ directory to a smithers AgentLike.
 * Supports an optional `harness:` discriminator to produce a CLI harness agent.
 */
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {import("../AgentLike.ts").AgentLike} AgentLike */

const HARNESS_MAP = {
  "claude-code": () => import("../ClaudeCodeAgent.js").then((m) => m.ClaudeCodeAgent),
  codex: () => import("../CodexAgent.js").then((m) => m.CodexAgent),
  gemini: () => import("../GeminiAgent.js").then((m) => m.GeminiAgent),
  amp: () => import("../AmpAgent.js").then((m) => m.AmpAgent),
  forge: () => import("../ForgeAgent.js").then((m) => m.ForgeAgent),
};

/**
 * Load instructions.md from the agent directory, or return null.
 * @param {string} agentDir
 * @returns {Promise<string|null>}
 */
async function loadInstructions(agentDir) {
  try {
    return await readFile(join(agentDir, "instructions.md"), "utf8");
  } catch {
    return null;
  }
}

// Staging area for dynamically imported tool files, inside the workspace so
// that bare package specifiers like "smithers-orchestrator/agent-kit" resolve
// via the workspace node_modules.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_STAGE_DIR = join(__dirname, "..", "..", "..", ".tools-stage");

/**
 * Discover tool files from tools/ and import them.
 * Returns a Record keyed by filename (without extension).
 * @param {string} agentDir
 * @returns {Promise<Record<string, unknown>>}
 */
async function loadTools(agentDir) {
  const toolsDir = join(agentDir, "tools");
  let entries;
  try {
    entries = await readdir(toolsDir);
  } catch {
    return {};
  }

  await mkdir(TOOLS_STAGE_DIR, { recursive: true });

  const tools = {};
  for (const entry of entries) {
    const ext = extname(entry);
    if (ext !== ".ts" && ext !== ".js") continue;
    const name = basename(entry, ext);
    // Stage the tool file inside the workspace so bare pkg specifiers resolve.
    const stageFile = join(TOOLS_STAGE_DIR, `${name}_${Date.now()}${ext}`);
    try {
      const src = await readFile(join(toolsDir, entry), "utf8");
      await writeFile(stageFile, src, "utf8");
      const mod = await import(stageFile);
      tools[name] = mod.default ?? mod;
    } catch {
      // tool failed to load — skip silently
    } finally {
      await rm(stageFile, { force: true }).catch(() => {});
    }
  }
  return tools;
}

/**
 * Discover skill names from skills/*.md.
 * @param {string} agentDir
 * @returns {Promise<string[]>}
 */
async function loadSkills(agentDir) {
  const skillsDir = join(agentDir, "skills");
  let entries;
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => extname(e) === ".md")
    .map((e) => basename(e, ".md"));
}

/**
 * Compile an agent/ directory to a smithers AgentLike.
 *
 * @param {object} opts
 * @param {string} [opts.id] - optional agent id
 * @param {string} [opts.model] - model string (required unless harness is set)
 * @param {string} [opts.harness] - CLI harness name ('claude-code', 'codex', ...)
 * @param {object} [opts.options] - extra options passed to harness constructor
 * @param {string} opts.agentDir - path to the agent/ directory
 * @returns {Promise<AgentLike>}
 */
export async function defineAgent(opts = {}) {
  const { id, model, harness, options = {}, agentDir } = opts;

  if (!model && !harness) {
    throw new Error(
      "defineAgent: model or harness is required. Pass model: '...' for an SDK agent or harness: '...' for a CLI harness agent."
    );
  }

  const instructions = agentDir ? await loadInstructions(agentDir) : null;
  const tools = agentDir ? await loadTools(agentDir) : {};
  const skills = agentDir ? await loadSkills(agentDir) : [];

  if (harness) {
    const resolveClass = HARNESS_MAP[harness];
    if (!resolveClass) {
      throw new Error(
        `defineAgent: unknown harness "${harness}". Known harnesses: ${Object.keys(HARNESS_MAP).join(", ")}.`
      );
    }
    const AgentClass = await resolveClass();
    const agentOpts = { ...options };
    if (model) agentOpts.model = model;
    if (instructions) agentOpts.systemPrompt = instructions;
    const agent = new AgentClass(agentOpts);
    // Expose eve-style fields for inspection
    if (id !== undefined) agent.id = id;
    agent.instructions = instructions ?? "";
    agent.tools = Object.keys(tools).length > 0 ? tools : agent.tools;
    agent.skills = skills;
    return agent;
  }

  // SDK / custom agent: return a minimal AgentLike backed by a generate stub.
  // A real implementation would wire up a ToolLoopAgent here; for now the
  // contract tests only assert shape, not actual generation.
  /** @type {AgentLike} */
  const agent = {
    id,
    instructions: instructions ?? "",
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    skills,
    generate: async (_args) => {
      throw new Error(
        "defineAgent: SDK agent generate() requires a ToolLoopAgent implementation. This stub is shape-only."
      );
    },
  };
  return agent;
}
